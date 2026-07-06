"use client";

import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoEditor from "monaco-editor";
import { useEffect, useRef } from "react";
import { requestCodeCompletion } from "@/lib/codeCompletionClient";
import {
  CodeCompletionLanguage,
  CodeCompletionTrigger,
  type CodeCompletionLanguage as CodeCompletionLanguageType,
} from "@/types/codeCompletion";

function languageForPath(path: string): CodeCompletionLanguageType {
  if (path.endsWith(".json")) return CodeCompletionLanguage.Json;
  if (path.endsWith(".html")) return CodeCompletionLanguage.Html;
  if (path.endsWith(".css")) return CodeCompletionLanguage.Css;
  if (path.endsWith(".js") || path.endsWith(".jsx")) return CodeCompletionLanguage.JavaScript;
  return CodeCompletionLanguage.TypeScript;
}

function clippedStart(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}

function clippedEnd(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function contextWindow(
  model: MonacoEditor.editor.ITextModel,
  position: MonacoEditor.Position,
  explicit: boolean
) {
  const beforeLines = explicit ? 160 : 80;
  const afterLines = explicit ? 80 : 40;
  const maxPrefixChars = explicit ? 8000 : 4000;
  const maxSuffixChars = explicit ? 3000 : 1500;
  const suffixEndLine = Math.min(model.getLineCount(), position.lineNumber + afterLines);

  const prefix = model.getValueInRange({
    startLineNumber: Math.max(1, position.lineNumber - beforeLines),
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const suffix = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: suffixEndLine,
    endColumn: model.getLineMaxColumn(suffixEndLine),
  });

  return {
    prefix: clippedStart(prefix, maxPrefixChars),
    suffix: clippedEnd(suffix, maxSuffixChars),
  };
}

function isSupportedPath(path: string) {
  return /\.(ts|tsx|js|jsx|css|html|json)$/.test(path);
}

function shouldRequestAutomaticCompletion(prefix: string, lineBeforeCursor: string) {
  const trimmedLine = lineBeforeCursor.trim();
  if (prefix.trim().length < 12) return false;
  if (!trimmedLine) return false;
  if (/\/\/\s*$/.test(lineBeforeCursor)) return false;
  if (/\/\*[^*]*$/.test(lineBeforeCursor)) return false;
  if (/from\s+["'][^"']*$/.test(lineBeforeCursor)) return false;
  if (/import\s+["'][^"']*$/.test(lineBeforeCursor)) return false;
  return true;
}

export default function CodeEditor({
  projectId,
  path,
  value,
  onChange,
  onSave,
  completionDisabled = false,
  readOnly = false,
}: {
  projectId?: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  completionDisabled?: boolean;
  readOnly?: boolean;
}) {
  const onSaveRef = useRef(onSave);
  const projectIdRef = useRef(projectId);
  const pathRef = useRef(path);
  const completionDisabledRef = useRef(completionDisabled);
  const readOnlyRef = useRef(readOnly);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    projectIdRef.current = projectId;
    pathRef.current = path;
    completionDisabledRef.current = completionDisabled;
    readOnlyRef.current = readOnly;
  }, [completionDisabled, path, projectId, readOnly]);

  const handleMount: OnMount = (editor, monaco) => {
    let activeRequest: AbortController | null = null;

    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.());

    const provider: Parameters<typeof monaco.languages.registerInlineCompletionsProvider>[1] = {
      async provideInlineCompletions(
        model: MonacoEditor.editor.ITextModel,
        position: MonacoEditor.Position,
        context: MonacoEditor.languages.InlineCompletionContext,
        token: MonacoEditor.CancellationToken
      ) {
        const currentProjectId = projectIdRef.current;
        const currentPath = pathRef.current;
        if (!currentProjectId || readOnlyRef.current || completionDisabledRef.current) {
          return { items: [] };
        }
        if (model !== editor.getModel() || !isSupportedPath(currentPath)) {
          return { items: [] };
        }

        const isExplicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
        const lineBeforeCursor = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const localContext = contextWindow(model, position, isExplicit);

        if (!isExplicit && !shouldRequestAutomaticCompletion(localContext.prefix, lineBeforeCursor)) {
          return { items: [] };
        }

        const version = model.getVersionId();
        const requestPath = currentPath;
        activeRequest?.abort();
        activeRequest = new AbortController();
        const disposeCancel = token.onCancellationRequested(() => activeRequest?.abort());

        try {
          const completion = await requestCodeCompletion(
            {
              projectId: currentProjectId,
              path: requestPath,
              language: languageForPath(requestPath),
              prefix: localContext.prefix,
              suffix: localContext.suffix,
              trigger: isExplicit ? CodeCompletionTrigger.Explicit : CodeCompletionTrigger.Automatic,
            },
            activeRequest.signal
          );

          if (
            token.isCancellationRequested
            || model.isDisposed()
            || model.getVersionId() !== version
            || pathRef.current !== requestPath
          ) {
            return { items: [] };
          }

          const insertText = completion.insertText;
          if (!insertText.trim()) return { items: [] };

          return {
            items: [{
              insertText,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column,
                endColumn: position.column,
              },
            }],
            suppressSuggestions: true,
          };
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.warn("Inline completion failed", error);
          }
          return { items: [] };
        } finally {
          disposeCancel.dispose();
        }
      },
      disposeInlineCompletions() {},
    };

    const disposable = monaco.languages.registerInlineCompletionsProvider(
      [
        CodeCompletionLanguage.TypeScript,
        CodeCompletionLanguage.JavaScript,
        CodeCompletionLanguage.Css,
        CodeCompletionLanguage.Html,
        CodeCompletionLanguage.Json,
      ],
      provider
    );

    editor.onDidDispose(() => {
      activeRequest?.abort();
      disposable.dispose();
    });
  };

  return (
    <Editor
      height="100%"
      language={languageForPath(path)}
      path={path}
      theme="vs-dark"
      value={value}
      onChange={(next) => {
        if (!readOnly) onChange(next ?? "");
      }}
      onMount={handleMount}
      options={{
        minimap: { enabled: false },
        fontSize: 12.7,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: "off",
        readOnly,
        domReadOnly: readOnly,
        renderLineHighlight: "none",
        padding: { top: 12 },
        inlineSuggest: {
          enabled: true,
          mode: "prefix",
          showToolbar: "onHover",
          minShowDelay: 220,
        },
      }}
    />
  );
}
