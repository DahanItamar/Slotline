import { useEffect, type ReactElement } from 'react';

export type ToastTone = 'error' | 'success';

export type ToastMessage = {
  id: number;
  tone: ToastTone;
  text: string;
};

export function Toast({
  message,
  onDismiss,
}: {
  message: ToastMessage;
  onDismiss: () => void;
}): ReactElement {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 6000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [message.id, onDismiss]);

  return (
    <div className={`toast toast--${message.tone}`} role="status" aria-live="polite">
      <span>{message.text}</span>
      <button type="button" className="toast__close" onClick={onDismiss} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
