import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../epn-book-deal-scout.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
