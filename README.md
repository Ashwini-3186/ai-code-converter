# Vini OpenRouter Code Translator

Convert source code between programming languages in VS Code using a multi-model OpenRouter ensemble.

## Features

- Convert the current file or an entire project.
- Supports JavaScript, TypeScript, Python, Java, C++, C, C#, Go, Rust, PHP, Kotlin, Swift, Ruby, and Scala.
- Uses multiple models and selects the best output:
  - `anthropic/claude-3-haiku`
  - `openai/gpt-4o`
  - `deepseek/deepseek-v3.2`
- Cleans and validates model output before saving.
- Keeps converted files in `converted/` while preserving project structure.
- Optional simplification pass after project conversion.

## Requirements

Create a `.env` file in the extension root or workspace root:

```env
OPENROUTER_API_KEY=your_api_key_here
```

## Usage

1. Open Command Palette and run `Code Translator: Pick Language and Convert`.
2. Choose:
   - Current File, or
   - Whole Project
3. Select the target language.
4. Converted output is written to `converted/`.

You can also use the **Code Translator** side panel and click:
- `Convert File`
- `Convert Project`

## Notes

- Skips files in `node_modules`, `.git`, and `converted`.
- Large files may be skipped in project mode for stability.
- Output quality depends on model/API availability.
