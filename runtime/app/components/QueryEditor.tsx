export interface QueryEditorProps { readonly value: string; readonly onChange?: (value: string) => void; readonly error?: string; }
export function renderQueryEditor(props: QueryEditorProps): string { return `<label>SQL 查询<textarea aria-label="SQL 查询">${escapeHtml(props.value)}</textarea>${props.error ? `<span role="alert">${escapeHtml(props.error)}</span>` : ""}</label>`; }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
