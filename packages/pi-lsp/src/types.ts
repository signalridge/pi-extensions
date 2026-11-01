export interface ServerCommand {
  command: string;
  args: string[];
}

export interface StatusContext {
  mode?: string;
  statusOwner?: object;
  sessionManager?: { getSessionId: () => string | undefined };
  ui: { setStatus: (key: string, value: string | undefined) => void };
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  codeDescription?: { href?: string };
  source?: string;
  message: string;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{
    textDocument?: { uri?: string; version?: number | null };
    edits?: LspTextEdit[];
    // Resource operations (create/rename/delete) carry a kind instead of edits.
    kind?: string;
  }>;
}

export interface CodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
  data?: unknown;
}

export interface DiagnosticEntry {
  path: string;
  uri: string;
  diagnostics: LspDiagnostic[];
}

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const LSP_OPERATIONS = ["diagnostics", "fix", "definition", "references", "hover", "symbols", "rename"] as const;

/** A pi-lsp tool, named without its `lsp_` prefix, that a server can be routed for. */
export type LspOperation = (typeof LSP_OPERATIONS)[number];

export interface ConfiguredLspServer {
  command: string[];
  extensions: string[];
  // Operations this server is routed for. Omitted means every operation.
  operations?: LspOperation[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  skipDirectories?: string[];
  // Quiet period in ms after the latest push-diagnostics publication.
  diagnosticsSettleMs?: number;
  // Maximum wait for a push-only server that publishes nothing for a clean document.
  pushDiagnosticsGraceMs?: number;
  // Maximum wait for a newer push publication after an empty pull result.
  pullDiagnosticsGraceMs?: number;
}

export interface LspConfig {
  timeout?: number;
  servers: InternalLspServer[];
}

export interface InternalLspServer extends ConfiguredLspServer {
  name: string;
  isDefault?: boolean;
}

export interface LspServerAdapter {
  name: string;
  isDefault: boolean;
  defaultCommand: ServerCommand;
  missingCommandHint: string;
  extensions: string[];
  // Undefined routes every operation.
  operations?: ReadonlySet<LspOperation>;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  skipDirectories: Set<string>;
  diagnosticsSettleMs?: number;
  pushDiagnosticsGraceMs?: number;
  pullDiagnosticsGraceMs?: number;
  isSupportedFile: (filePath: string) => boolean;
  languageIdFor: (filePath: string) => string;
}

export interface DiagnosticSummary {
  files: number;
  diagnostics: number;
}
