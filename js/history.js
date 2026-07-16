// Snapshot-based undo/redo stack, depth-limited.
// Snapshots are opaque to this class — the store serializes/deserializes them
// (it splits the multi-MB background image out so snapshots stay cheap).

export class History {
  constructor(depth = 10) {
    this.depth  = depth;
    this.past   = []; // snapshots (oldest first)
    this.future = []; // snapshots (most-recent-undone first)
  }

  /** Call BEFORE mutating state with the pre-mutation snapshot. */
  save(snapshot) {
    this.past.push(snapshot);
    if (this.past.length > this.depth) this.past.shift();
    this.future = [];
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  /** Returns the previous snapshot, or null if nothing to undo. */
  undo(currentSnapshot) {
    if (!this.canUndo()) return null;
    this.future.push(currentSnapshot);
    return this.past.pop();
  }

  /** Returns the next snapshot, or null if nothing to redo. */
  redo(currentSnapshot) {
    if (!this.canRedo()) return null;
    this.past.push(currentSnapshot);
    return this.future.pop();
  }
}
