// Compatibility entry for tooling that expects the product root to be TSX.
// The current shell is intentionally dependency-light; the public mount
// contract is shared with App.ts so the validation harness stays independent.
export { mountWorkbench } from "./App";
