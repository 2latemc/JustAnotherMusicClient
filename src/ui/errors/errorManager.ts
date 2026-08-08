import { useSyncExternalStore } from "react";

export const GITHUB_REPOSITORY_URL = "https://github.com/2latemc/JustAnotherMusicClient";
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPOSITORY_URL}/issues/new/choose`;

const ERROR_AUTO_DISMISS_MS = 8000;

export interface AppErrorNotification {
  id: number;
  title: string;
  message: string;
  createdAt: number;
}

interface ReportErrorOptions {
  title?: string;
}

type Listener = () => void;

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

class AppErrorManager {
  private notifications: AppErrorNotification[] = [];
  private listeners = new Set<Listener>();
  private timers = new Map<number, number>();
  private nextId = 1;

  getState(): AppErrorNotification[] {
    return this.notifications;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  report(error: unknown, options: ReportErrorOptions = {}): number {
    const message = getErrorMessage(error).trim() || "An unknown error occurred.";
    const notification: AppErrorNotification = {
      id: this.nextId,
      title: options.title ?? "Error",
      message,
      createdAt: Date.now(),
    };
    this.nextId += 1;
    this.notifications = [notification, ...this.notifications];
    this.emit();

    const timerId = window.setTimeout(() => {
      this.dismiss(notification.id);
    }, ERROR_AUTO_DISMISS_MS);
    this.timers.set(notification.id, timerId);
    return notification.id;
  }

  dismiss(id: number): void {
    const timerId = this.timers.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.timers.delete(id);
    }

    const nextNotifications = this.notifications.filter((notification) => notification.id !== id);
    if (nextNotifications.length === this.notifications.length) return;
    this.notifications = nextNotifications;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const appErrorManager = new AppErrorManager();

export function useAppErrorNotifications() {
  return useSyncExternalStore(
    (listener) => appErrorManager.subscribe(listener),
    () => appErrorManager.getState(),
    () => appErrorManager.getState(),
  );
}
