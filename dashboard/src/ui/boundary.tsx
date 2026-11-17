import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one page that cannot be drawn from taking the whole dashboard with it.
 * The records are checked before any page reads them (lib/validate.ts); this is
 * for whatever gets past that, so a supervisor always has a way on.
 */
export class Boundary extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A page could not be shown:', error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}
