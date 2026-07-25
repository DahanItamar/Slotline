import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line before a white screen. SPEC §10 M5.
 *
 * A calendar that throws while rendering should say so and offer a way out, not vanish —
 * and the message must not be the exception text, which is for the console, not for
 * someone trying to book a room.
 */
type Props = { children: ReactNode };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Slotline: render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="page__empty" role="alert">
        <h2>Something went wrong on this screen</h2>
        <p>
          Your bookings are safe — this is a display problem, not a data one. Reloading usually
          clears it.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
