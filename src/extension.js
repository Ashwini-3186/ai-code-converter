const vscode = require('vscode');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_PROJECT_FILE_CHARS = 5000;
const MAX_SINGLE_FILE_CHARS = 50000;
const MAX_RETRIES = 2;
const API_DELAY_MS = 250;
const VIEW_ID = 'code-translator-view';
const COMMAND_CONVERT = 'codeTranslator.pickLanguageAndConvert';
const COMMAND_CONVERT_PROJECT = 'codeTranslator.convertProject';

const MODEL_CONFIGS = [
    { id: 'anthropic/claude-3-haiku', weight: 3 },
    { id: 'openai/gpt-4o', weight: 2 },
    { id: 'deepseek/deepseek-v3.2', weight: 1 }
];

const LANGUAGE_EXTENSIONS = {
    JavaScript: '.js',
    TypeScript: '.ts',
    Python: '.py',
    Java: '.java',
    'C++': '.cpp',
    C: '.c',
    'C#': '.cs',
    Go: '.go',
    Rust: '.rs',
    PHP: '.php',
    Kotlin: '.kt',
    Swift: '.swift',
    Ruby: '.rb',
    Scala: '.scala'
};

const EXTENSION_TO_LANGUAGE = Object.entries(LANGUAGE_EXTENSIONS).reduce((acc, [lang, ext]) => {
    acc[ext] = lang;
    return acc;
}, {});

const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_EXTENSIONS);
const SUPPORTED_GLOB = `**/*.{${Object.values(LANGUAGE_EXTENSIONS).map((ext) => ext.slice(1)).join(',')}}`;

function getWebviewContent() {
    const htmlPath = path.join(__dirname, 'webview', 'sidebar.html');
    return fs.readFileSync(htmlPath, 'utf-8');
}

function loadEnv(context) {
    const envCandidates = [
        path.resolve(context.extensionPath, '.env'),
        path.resolve(__dirname, '../.env'),
        ...(vscode.workspace.workspaceFolders || []).map((folder) => path.resolve(folder.uri.fsPath, '.env'))
    ];

    for (const envPath of envCandidates) {
        const result = dotenv.config({ path: envPath });
        if (!result.error && process.env.OPENROUTER_API_KEY) {
            return true;
        }
    }

    return false;
}

function buildTranslationPrompt(sourceLang, targetLang, code) {
    return `You are a compiler-level code translator.

Convert ${sourceLang} code into ${targetLang}.

STRICT RULES:

* Output ONLY valid ${targetLang} code
* No explanations
* No markdown
* No extra text
* No added comments unless present
* Must be directly executable

Return ONLY raw code.

${code}`;
}

function buildSimplificationPrompt(language, code) {
    return `You are a senior ${language} engineer.

Refactor this ${language} code to make it simpler and more commonly used by most programmers.

STRICT RULES:

* Keep behavior same
* Use idiomatic and beginner-friendly style
* Keep code compilable/runnable
* No explanations
* No markdown
* No extra text
* No added comments unless already present

Return ONLY raw code.

${code}`;
}

function sanitizeModelOutput(output) {
    if (typeof output !== 'string') {
        return '';
    }

    let cleaned = output.replace(/\r\n/g, '\n').trim();
    cleaned = cleaned.replace(/^```[\w-]*\s*/i, '').replace(/```$/i, '').trim();
    cleaned = cleaned
        .split('\n')
        .filter((line) => !/^\s*(here is( the)?|converted code|output:|sure[,!]?)/i.test(line))
        .filter((line) => line.trim().length > 0)
        .join('\n');

    return `${cleaned.trimEnd()}\n`;
}

function getLanguageMismatchPatterns(targetLang) {
    const patterns = {
        'C++': [
            /String\[\]\s+args/i,
            /\bSystem\.out\.println\b/,
            /\bpublic\s+static\s+void\s+main\b/i
        ],
        C: [
            /String\[\]\s+args/i,
            /\bSystem\.out\.println\b/,
            /\bpublic\s+static\s+void\s+main\b/i,
            /\bstd::/i
        ],
        Java: [
            /#include\s*</i,
            /\bstd::/i,
            /\bconsole\.log\b/i
        ],
        Python: [
            /#include\s*</i,
            /\bpublic\s+static\s+void\s+main\b/i,
            /\bint\s+main\s*\(/i
        ]
    };

    return patterns[targetLang] || [];
}

function validateOutput(output, targetLang) {
    const value = (output || '').trim();
    if (value.length < 10) {
        return { valid: false, reason: 'Output too short' };
    }
    if (value.includes('```')) {
        return { valid: false, reason: 'Contains markdown fences' };
    }
    if (/(here is|converted|explanation|output:)/i.test(value)) {
        return { valid: false, reason: 'Contains explanatory text' };
    }
    const mismatchPatterns = getLanguageMismatchPatterns(targetLang);
    for (const pattern of mismatchPatterns) {
        if (pattern.test(value)) {
            return { valid: false, reason: `Contains non-${targetLang} syntax` };
        }
    }
    return { valid: true };
}

function scoreOutput(output, modelId, targetLang) {
    const modelWeight = MODEL_CONFIGS.find((item) => item.id === modelId)?.weight || 0;
    const lengthScore = Math.min(output.length, 4000) / 20;
    const syntaxHints = (output.match(/[{}();=<>\[\]]/g) || []).length;
    const markdownPenalty = output.includes('```') ? 500 : 0;
    const textPenalty = /(here is|converted|explanation|output:)/i.test(output) ? 300 : 0;
    const mismatchPenalty = getLanguageMismatchPatterns(targetLang).some((pattern) => pattern.test(output)) ? 600 : 0;
    return lengthScore + syntaxHints + modelWeight * 10 - markdownPenalty - textPenalty - mismatchPenalty;
}

function isSkippablePath(fsPath) {
    const normalized = fsPath.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/node_modules/') || normalized.includes('/.git/') || normalized.includes('/converted/');
}

function extractMessageContent(responseJson) {
    const messageContent = responseJson?.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string') {
        return messageContent;
    }
    if (Array.isArray(messageContent)) {
        return messageContent.map((item) => item?.text || '').join('\n');
    }
    return '';
}

async function callModelWithRetry(apiKey, modelId, prompt, targetLang) {
    let lastError = 'Unknown failure';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(OPENROUTER_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'http://localhost',
                    'X-Title': 'AI Converter VSCode Extension'
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            const rawOutput = extractMessageContent(payload);
            const cleanedOutput = sanitizeModelOutput(rawOutput);
            const validation = validateOutput(cleanedOutput, targetLang);
            if (!validation.valid) {
                lastError = validation.reason || 'Invalid model output';
                continue;
            }

            return { success: true, modelId, output: cleanedOutput };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }

    return { success: false, modelId, error: lastError };
}

async function convertCodeWithEnsemble(apiKey, sourceLang, targetLang, code) {
    const prompt = buildTranslationPrompt(sourceLang, targetLang, code);
    const tasks = MODEL_CONFIGS.map((model, index) =>
        new Promise((resolve) => {
            setTimeout(async () => {
                const result = await callModelWithRetry(apiKey, model.id, prompt, targetLang);
                resolve(result);
            }, index * API_DELAY_MS);
        })
    );

    const results = await Promise.all(tasks);
    const valid = results.filter((item) => item.success);
    if (!valid.length) {
        return { success: false, error: results.map((r) => `${r.modelId}: ${r.error}`).join(' | ') };
    }

    const best = valid
        .map((result) => ({ ...result, score: scoreOutput(result.output, result.modelId, targetLang) }))
        .sort((a, b) => b.score - a.score)[0];

    return { success: true, output: best.output, modelId: best.modelId };
}

async function simplifyCodeWithEnsemble(apiKey, language, code) {
    const prompt = buildSimplificationPrompt(language, code);
    const tasks = MODEL_CONFIGS.map((model, index) =>
        new Promise((resolve) => {
            setTimeout(async () => {
                const result = await callModelWithRetry(apiKey, model.id, prompt, language);
                resolve(result);
            }, index * API_DELAY_MS);
        })
    );

    const results = await Promise.all(tasks);
    const valid = results.filter((item) => item.success);
    if (!valid.length) {
        return { success: false, error: results.map((r) => `${r.modelId}: ${r.error}`).join(' | ') };
    }

    const best = valid
        .map((result) => ({ ...result, score: scoreOutput(result.output, result.modelId, language) }))
        .sort((a, b) => b.score - a.score)[0];

    return { success: true, output: best.output, modelId: best.modelId };
}

async function convertSingleFile({
    apiKey,
    sourceUri,
    workspaceFolder,
    targetLang,
    webviewView,
    maxChars
}) {
    const ext = path.extname(sourceUri.fsPath);
    const sourceLang = EXTENSION_TO_LANGUAGE[ext];
    if (!sourceLang) {
        return { skipped: true, reason: `Unsupported extension: ${ext || 'unknown'}` };
    }
    if (sourceLang === targetLang) {
        return { skipped: true, reason: `Source and target are both ${targetLang}` };
    }
    if (isSkippablePath(sourceUri.fsPath)) {
        return { skipped: true, reason: 'File is inside skipped folder (node_modules/.git/converted)' };
    }

    const contentBytes = await vscode.workspace.fs.readFile(sourceUri);
    const content = Buffer.from(contentBytes).toString('utf-8');
    if (!content || content.trim().length === 0) {
        return { skipped: true, reason: 'File is empty' };
    }
    if (content.length > maxChars) {
        return { skipped: true, reason: `File too large (${content.length} chars > ${maxChars})` };
    }

    const result = await convertCodeWithEnsemble(apiKey, sourceLang, targetLang, content);
    if (!result.success) {
        console.error(`Failed to convert ${sourceUri.fsPath}: ${result.error}`);
        return { skipped: true, reason: result.error || 'Conversion failed' };
    }

    const convertedRoot = vscode.Uri.joinPath(workspaceFolder.uri, 'converted');
    await vscode.workspace.fs.createDirectory(convertedRoot);

    const relativePath = path.relative(workspaceFolder.uri.fsPath, sourceUri.fsPath);
    const sourceDir = path.dirname(relativePath);
    const targetFileName = `${path.basename(relativePath, ext)}${LANGUAGE_EXTENSIONS[targetLang]}`;
    const outputRelativePath = path.join(sourceDir, targetFileName);
    const outputDirUri = vscode.Uri.joinPath(convertedRoot, sourceDir);
    const outputFileUri = vscode.Uri.joinPath(convertedRoot, outputRelativePath);

    await vscode.workspace.fs.createDirectory(outputDirUri);
    await vscode.workspace.fs.writeFile(outputFileUri, Buffer.from(result.output, 'utf-8'));

    if (webviewView) {
        await webviewView.webview.postMessage({
            type: 'status',
            message: `Converted ${path.basename(sourceUri.fsPath)} via ${result.modelId}`
        });
    }

    return { skipped: false, outputUri: outputFileUri, modelId: result.modelId };
}

async function simplifyConvertedProject({ apiKey, workspaceFolder, targetLang, webviewView, progress, token }) {
    const convertedRoot = vscode.Uri.joinPath(workspaceFolder.uri, 'converted');
    const convertedFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(convertedRoot, '**/*'),
        '**/{node_modules,.git}/**'
    );

    const candidates = convertedFiles.filter((file) => path.extname(file.fsPath) === LANGUAGE_EXTENSIONS[targetLang]);
    let simplified = 0;
    let skipped = 0;

    for (let i = 0; i < candidates.length; i++) {
        if (token?.isCancellationRequested) {
            break;
        }

        const file = candidates[i];
        progress?.report({ message: `Simplifying ${path.basename(file.fsPath)} (${i + 1}/${candidates.length})` });
        if (webviewView) {
            await webviewView.webview.postMessage({
                type: 'status',
                message: `Simplifying: ${path.basename(file.fsPath)}`
            });
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const content = Buffer.from(bytes).toString('utf-8');
            if (!content || content.length > MAX_PROJECT_FILE_CHARS) {
                skipped++;
                continue;
            }

            const result = await simplifyCodeWithEnsemble(apiKey, targetLang, content);
            if (!result.success) {
                skipped++;
                console.error(`Simplification failed for ${file.fsPath}: ${result.error}`);
                continue;
            }

            await vscode.workspace.fs.writeFile(file, Buffer.from(result.output, 'utf-8'));
            simplified++;
        } catch (error) {
            skipped++;
            console.error(`Unexpected simplification failure for ${file.fsPath}:`, error);
        }

        await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
    }

    return { simplified, skipped };
}

class AIConverterViewProvider {
    resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true };
        webviewView.webview.html = getWebviewContent();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'convertProject') {
                await handleConvertProject(message.language, webviewView);
            }
            if (message.command === 'convertFile') {
                await handleConvertFile(message.language, webviewView);
            }
        });
    }
}

async function pickTargetLanguage() {
    return vscode.window.showQuickPick(SUPPORTED_LANGUAGES, { placeHolder: 'Choose target language' });
}

async function pickConversionScope() {
    return vscode.window.showQuickPick(
        [
            { label: 'Current File', value: 'file', description: 'Convert only active file' },
            { label: 'Whole Project', value: 'project', description: 'Convert all supported files' }
        ],
        { placeHolder: 'Choose conversion scope' }
    );
}

function requireApiKey(webviewView) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
        return apiKey;
    }

    if (webviewView) {
        webviewView.webview.postMessage({ type: 'error', message: 'OPENROUTER_API_KEY missing in .env' });
    }
    vscode.window.showErrorMessage('OPENROUTER_API_KEY missing in .env');
    return null;
}

async function handleConvertFile(targetLang, webviewView) {
    const apiKey = requireApiKey(webviewView);
    if (!apiKey) {
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file to convert.');
        return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found for current file.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Converting file to ${targetLang}`, cancellable: false },
        async (progress) => {
            progress.report({ message: 'Running ensemble conversion...' });
            const result = await convertSingleFile({
                apiKey,
                sourceUri: editor.document.uri,
                workspaceFolder,
                targetLang,
                webviewView,
                maxChars: MAX_SINGLE_FILE_CHARS
            });

            if (result.skipped) {
                const msg = `Conversion skipped: ${result.reason}`;
                if (webviewView) {
                    await webviewView.webview.postMessage({ type: 'error', message: msg });
                }
                vscode.window.showWarningMessage(msg);
                return;
            }

            const convertedDoc = await vscode.workspace.openTextDocument(result.outputUri);
            await vscode.window.showTextDocument(convertedDoc);

            if (webviewView) {
                await webviewView.webview.postMessage({ type: 'complete', message: `File converted via ${result.modelId}` });
            }
            vscode.window.showInformationMessage(`File converted via ${result.modelId}`);
        }
    );
}

async function handleConvertProject(targetLang, webviewView) {
    const apiKey = requireApiKey(webviewView);
    if (!apiKey) {
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const files = await vscode.workspace.findFiles(SUPPORTED_GLOB);
    if (!files.length) {
        vscode.window.showWarningMessage('No supported files found in workspace.');
        return;
    }

    let processed = 0;
    let skipped = 0;
    let simplified = 0;
    let simplifySkipped = 0;
    let cancelled = false;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Converting project to ${targetLang}`, cancellable: true },
        async (progress, token) => {
            const total = files.length;
            for (let i = 0; i < total; i++) {
                if (token.isCancellationRequested) {
                    cancelled = true;
                    break;
                }

                const file = files[i];
                progress.report({
                    message: `Processing ${path.basename(file.fsPath)} (${i + 1}/${total})`,
                    increment: 100 / total
                });

                try {
                    const result = await convertSingleFile({
                        apiKey,
                        sourceUri: file,
                        workspaceFolder,
                        targetLang,
                        webviewView,
                        maxChars: MAX_PROJECT_FILE_CHARS
                    });

                    if (result.skipped) {
                        skipped++;
                    } else {
                        processed++;
                    }
                } catch (error) {
                    skipped++;
                    console.error(`Unexpected conversion failure for ${file.fsPath}:`, error);
                }

                await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
            }

            if (!cancelled && processed > 0) {
                progress.report({ message: 'Running simplification pass on converted project...' });
                const simplifyResult = await simplifyConvertedProject({
                    apiKey,
                    workspaceFolder,
                    targetLang,
                    webviewView,
                    progress,
                    token
                });
                simplified = simplifyResult.simplified;
                simplifySkipped = simplifyResult.skipped;
            }
        }
    );

    const summary = cancelled
        ? `Conversion cancelled. Converted ${processed}, skipped ${skipped}.`
        : `Conversion complete. Converted ${processed}, skipped ${skipped}. Simplified ${simplified}, simplify-skipped ${simplifySkipped}.`;

    if (webviewView) {
        await webviewView.webview.postMessage({ type: cancelled ? 'error' : 'complete', message: summary });
    }

    if (cancelled) {
        vscode.window.showWarningMessage(summary);
    } else {
        vscode.window.showInformationMessage(summary);
    }
}

function createSidebar(context) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, new AIConverterViewProvider()));
}

function activate(context) {
    loadEnv(context);
    createSidebar(context);

    const commandConvert = vscode.commands.registerCommand(COMMAND_CONVERT, async () => {
        const scope = await pickConversionScope();
        if (!scope) {
            return;
        }

        const targetLang = await pickTargetLanguage();
        if (!targetLang) {
            return;
        }

        if (scope.value === 'file') {
            await handleConvertFile(targetLang, null);
        } else {
            await handleConvertProject(targetLang, null);
        }
    });

    const commandConvertProject = vscode.commands.registerCommand(COMMAND_CONVERT_PROJECT, async () => {
        const targetLang = await pickTargetLanguage();
        if (!targetLang) {
            return;
        }
        await handleConvertProject(targetLang, null);
    });

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = COMMAND_CONVERT;
    statusBarItem.text = '$(sparkle) Code Translate';
    statusBarItem.tooltip = 'Convert current file or project between programming languages';
    statusBarItem.show();

    context.subscriptions.push(commandConvert, commandConvertProject, statusBarItem);
}

function deactivate() {}

module.exports = { activate, deactivate };