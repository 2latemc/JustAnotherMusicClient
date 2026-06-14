import type { Track } from "../datasource/types";

export class Queue {
  private items: Track[] = [];
  private index = -1;
  private manualQueueLength = 0;
  private sourceTracks: Track[] = [];

  get current(): Track | null {
    return this.index >= 0 && this.index < this.items.length
      ? this.items[this.index]
      : null;
  }

  get all(): readonly Track[] {
    return this.items;
  }

  get currentIndex(): number {
    return this.index;
  }

  get queuedManually(): number {
    return this.manualQueueLength;
  }

  set(tracks: Track[], startIndex = 0, manualQueueLength = 0) {
    this.items = tracks;
    this.index = tracks.length === 0
      ? -1
      : Math.min(Math.max(startIndex, 0), tracks.length - 1);
    this.manualQueueLength = Math.min(
      Math.max(manualQueueLength, 0),
      Math.max(0, tracks.length - this.index - 1),
    );
    this.sourceTracks = [];
  }

  add(track: Track): void {
    if (this.index < 0) {
      this.items = [track];
      this.index = 0;
      return;
    }

    this.items.splice(this.index + 1 + this.manualQueueLength, 0, track);
    this.manualQueueLength += 1;
  }

  playNext(track: Track): void {
    if (this.index < 0) {
      this.items = [track];
      this.index = 0;
      return;
    }

    this.items.splice(this.index + 1, 0, track);
    this.manualQueueLength += 1;
  }

  get remainingAutomatic(): number {
    const automaticStart = this.index + 1 + this.manualQueueLength;
    return Math.max(0, this.items.length - automaticStart);
  }

  getSourceTracks(): Track[] {
    return this.sourceTracks;
  }

  setSourceTracks(tracks: Track[]): void {
    this.sourceTracks = tracks;
  }

  appendAutomaticTracks(tracks: Track[]): void {
    if (tracks.length === 0) return;
    if (this.index < 0) {
      this.items = tracks;
      this.index = 0;
      return;
    }
    const manualQueueEnd = this.index + 1 + this.manualQueueLength;
    this.items = [...this.items.slice(0, manualQueueEnd), ...tracks];
  }

  replaceAutomaticUpcoming(tracks: Track[]): void {
    if (this.index < 0) {
      this.set(tracks);
      return;
    }

    const manualQueueEnd = this.index + 1 + this.manualQueueLength;
    this.items = [...this.items.slice(0, manualQueueEnd), ...tracks];
  }

  next(wrap = true): Track | null {
    if (this.items.length === 0) return null;
    if (this.index + 1 >= this.items.length) {
      if (!wrap) return null;
      this.index = 0;
      return this.current;
    }
    this.index += 1;
    if (this.manualQueueLength > 0) this.manualQueueLength -= 1;
    return this.current;
  }

  prev(wrap = true): Track | null {
    if (this.items.length === 0) return null;
    if (this.index - 1 < 0) {
      if (!wrap) return null;
      this.index = this.items.length - 1;
      return this.current;
    }
    this.index -= 1;
    this.manualQueueLength = 0;
    return this.current;
  }

  removeAt(index: number): void {
    if (index < 0 || index >= this.items.length) return;

    const manualQueueStart = this.index + 1;
    const manualQueueEnd = this.index + 1 + this.manualQueueLength;
    const removedFromManual = index >= manualQueueStart && index < manualQueueEnd;

    this.items.splice(index, 1);

    if (removedFromManual) {
      this.manualQueueLength = Math.max(0, this.manualQueueLength - 1);
    }

    if (index <= this.index) {
      this.index = Math.max(0, this.index - 1);
    }
  }

  select(index: number): Track | null {
    if (index < 0 || index >= this.items.length) return null;

    const manualQueueStart = this.index + 1;
    const manualQueueEnd = manualQueueStart + this.manualQueueLength;
    this.index = index;
    this.manualQueueLength = index >= manualQueueStart && index < manualQueueEnd
      ? Math.max(0, manualQueueEnd - index - 1)
      : 0;
    return this.current;
  }

  move(sourceIndex: number, targetIndex: number, insertAfter: boolean): void {
    const manualQueueStart = this.index + 1;
    const manualQueueEnd = manualQueueStart + this.manualQueueLength;
    const sourceIsManual = sourceIndex >= manualQueueStart && sourceIndex < manualQueueEnd;
    const targetIsManual = targetIndex >= manualQueueStart && targetIndex < manualQueueEnd;
    if (
      sourceIndex <= this.index
      || targetIndex <= this.index
      || sourceIndex >= this.items.length
      || targetIndex >= this.items.length
      || sourceIndex === targetIndex
      || sourceIsManual !== targetIsManual
    ) return;

    const [track] = this.items.splice(sourceIndex, 1);
    const adjustedTargetIndex = targetIndex > sourceIndex
      ? targetIndex - 1
      : targetIndex;
    const insertIndex = adjustedTargetIndex + (insertAfter ? 1 : 0);
    this.items.splice(insertIndex, 0, track);
  }

  private originalUpcoming: Track[] | null = null;

  shuffleRemaining(manualCount: number): void {
    const manualQueueEnd = this.index + 1 + manualCount;
    const upcoming = this.items.slice(manualQueueEnd);
    if (upcoming.length <= 1) return;

    if (this.originalUpcoming === null) {
      this.originalUpcoming = [...upcoming];
    }

    for (let i = upcoming.length - 1; i > 0; i -= 1) {
      const swapIndex = Math.floor(Math.random() * (i + 1));
      [upcoming[i], upcoming[swapIndex]] = [upcoming[swapIndex], upcoming[i]];
    }

    this.items = [...this.items.slice(0, manualQueueEnd), ...upcoming];
  }

  restoreOriginalOrder(manualCount: number): void {
    if (!this.originalUpcoming) return;
    const manualQueueEnd = this.index + 1 + manualCount;
    this.items = [...this.items.slice(0, manualQueueEnd), ...this.originalUpcoming];
    this.originalUpcoming = null;
  }
}
