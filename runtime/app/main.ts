import { mountWorkbench } from "./App";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("Workbench root is missing");
mountWorkbench(root);
