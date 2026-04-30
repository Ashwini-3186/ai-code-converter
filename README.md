# OpenRouter Code Translator

Convert source code from one language to another directly in VS Code using a multi-model OpenRouter ensemble.

## Features

- Convert the current file or an entire project.
- Support for JavaScript, TypeScript, Python, Java, C++, C, C#, Go, Rust, PHP, Kotlin, Swift, Ruby, and Scala.
- Multi-model conversion using:
  - `anthropic/claude-3.5-sonnet`
  - `openai/gpt-4o`
  - `deepseek/deepseek-coder`
- Automatic output cleaning, validation, scoring, and best-result selection.
- Optional project-wide simplification pass for common, beginner-friendly style.
- Converted files are written to a `converted/` folder with original structure preserved.

## Requirements

- Create a `.env` file in the extension root or workspace root.
- Add:

```env
OPENROUTER_API_KEY=your_api_key_here
```

## Usage

1. Open Command Palette and run `Code Translator: Pick Language and Convert`, or use the status bar button.
2. Choose conversion scope:
   - Current File
   - Whole Project
3. Choose target language.
4. Find output under `converted/`.

You can also use the **Code Translator** activity bar view and click:
- `Convert File`
- `Convert Project`

## Notes

- Project conversion skips files in `node_modules`, `.git`, and `converted`.
- Very large files are skipped in project mode for stability.
- Conversion quality depends on model availability and API responses.
