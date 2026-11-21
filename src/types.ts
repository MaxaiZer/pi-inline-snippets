export interface SnippetReference {
  name: string;
  raw: string;
  start: number;
  end: number;
}

export interface ProtectedRange {
  start: number;
  end: number;
}

export interface ExpansionResult {
  text: string;
  expanded: number;
}

export type SnippetReader = (name: string) => Promise<string | undefined>;

export type SnippetLogger = (message: string, ...details: unknown[]) => void;

export interface SnippetDirectories {
  globalDir: string;
  projectDir: string;
}
