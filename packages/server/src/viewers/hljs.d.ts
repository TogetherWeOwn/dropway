// Types for ./hljs.js (see the note there on why highlight.js's own types are not used).
declare const hljs: {
  registerLanguage(name: string, language: (hljs: unknown) => unknown): void;
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string; language?: string; relevance: number };
};
export default hljs;
