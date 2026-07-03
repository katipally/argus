"use client";

import { Component, type ReactNode } from "react";

interface Props {
  /** Which subsystem this guards — shown in the fallback. */
  name: string;
  children: ReactNode;
}

/** Catches render errors so one broken panel (or the map) can't blank the app. */
export default class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[argus] ${this.props.name} fault:`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel pointer-events-auto m-5 max-w-sm px-4 py-3">
        <div className="label text-[var(--color-alert)]">subsystem fault · {this.props.name}</div>
        <div className="mt-1 text-[12px] text-[var(--color-muted)]">{this.state.error.message}</div>
        <button
          className="label mt-2 cursor-pointer text-[var(--color-accent)] hover:underline"
          onClick={() => this.setState({ error: null })}
        >
          restart subsystem ▸
        </button>
      </div>
    );
  }
}
