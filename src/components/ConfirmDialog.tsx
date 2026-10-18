"use client";

import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "primary" | "danger";
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  tone,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        data-testid="confirm-dialog"
      >
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-description">{description}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${tone === "danger" ? "btn-danger" : "btn-accent"}`}
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-button"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
