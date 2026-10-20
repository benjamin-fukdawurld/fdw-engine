/**
 * A reversible change: `do()` applies it (again, after an undo), `undo()`
 * puts things back as they were before. A command keeps what it needs to do
 * both: the values before and after, the nodes it created or removed.
 */
export interface Command {
  /** What the history shows: "Move 3 objects". */
  readonly label: string;
  do(): void;
  undo(): void;
  /**
   * Absorbs the command that follows, done just after this one (another
   * step of the same slider): returns true when it did, and the history
   * keeps one entry. Optional.
   */
  merge?(next: Command): boolean;
  /**
   * Called when the history drops the command for good (out of its limit,
   * or undone and replaced by a new one): frees what it kept (the nodes it
   * removed, kept to be put back). `undone` says in which state it was.
   */
  dispose?(undone: boolean): void;
}

/** A command made of others, done in order and undone in reverse. */
export class CommandGroup implements Command {
  constructor(
    readonly label: string,
    readonly commands: readonly Command[],
  ) {}

  do(): void {
    for (const command of this.commands) {
      command.do();
    }
  }

  undo(): void {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i].undo();
    }
  }

  dispose(undone: boolean): void {
    for (const command of this.commands) {
      command.dispose?.(undone);
    }
  }
}

/** A command of two functions: see Command. */
export function defineCommand(
  label: string,
  apply: () => void,
  revert: () => void,
): Command {
  return { label, do: apply, undo: revert };
}

export interface HistoryOptions {
  /** The entries kept; the oldest are dropped. Default 100. */
  readonly limit?: number;
}

// A transaction being recorded: its commands, done already.
interface OpenTransaction {
  readonly label: string;
  readonly commands: Command[];
}

/**
 * The history of the changes: the commands done, to undo and redo them.
 *
 * ```ts
 * const history = new History();
 * history.execute(new TransformCommand('Move', nodes, before, after));
 * history.undo();
 * history.redo();
 *
 * // Several commands, one entry.
 * history.transaction('Duplicate', () => {
 *   history.execute(create);
 *   history.execute(move);
 * });
 * ```
 *
 * Executing a command after undos drops those undone: they cannot be redone
 * anymore.
 */
export class History {
  readonly limit: number;
  private readonly _done: Command[] = [];
  private readonly _undone: Command[] = [];
  private readonly _open: OpenTransaction[] = [];
  private readonly _listeners: (() => void)[] = [];
  // The last command can absorb the next one (merge): not after an undo,
  // a redo or a transaction.
  private _mergeable = false;

  constructor({ limit = 100 }: HistoryOptions = {}) {
    this.limit = Math.max(1, limit);
  }

  /** Does a command, and records it (in the open transaction, if any). */
  execute(command: Command): void {
    command.do();
    this.record(command);
  }

  /**
   * Records a command already done: the changes made live during a drag
   * (a gizmo moves the objects at each step), recorded once at the end.
   */
  record(command: Command): void {
    const open = this._open.at(-1);
    if (open) {
      open.commands.push(command);
      return;
    }
    this.push(command, true);
  }

  /**
   * Opens a transaction: the commands executed until commit() make one
   * entry, undone at once. Transactions nest: only the outermost makes the
   * entry.
   */
  begin(label: string): void {
    this._open.push({ label, commands: [] });
  }

  /** Closes the last transaction opened; nothing is recorded if it is empty. */
  commit(): void {
    const open = this._open.pop();
    if (!open) {
      throw new Error('No transaction is open');
    }
    if (open.commands.length === 0) {
      return;
    }
    const command =
      open.commands.length === 1 && open.commands[0].label === open.label
        ? open.commands[0]
        : new CommandGroup(open.label, open.commands);
    const parent = this._open.at(-1);
    if (parent) {
      parent.commands.push(command);
    } else {
      this.push(command, false);
    }
  }

  /** Closes the last transaction opened, undoing what it did. */
  cancel(): void {
    const open = this._open.pop();
    if (!open) {
      throw new Error('No transaction is open');
    }
    for (let i = open.commands.length - 1; i >= 0; i--) {
      open.commands[i].undo();
      open.commands[i].dispose?.(true);
    }
  }

  /**
   * Runs `body` in a transaction: committed when it returns, cancelled
   * when it throws.
   */
  transaction<T>(label: string, body: () => T): T {
    this.begin(label);
    try {
      const result = body();
      this.commit();
      return result;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  /** Whether a transaction is open. */
  get recording(): boolean {
    return this._open.length > 0;
  }

  get canUndo(): boolean {
    return this._done.length > 0 && !this.recording;
  }

  get canRedo(): boolean {
    return this._undone.length > 0 && !this.recording;
  }

  /** The labels of the entries that can be undone, the oldest first. */
  get undoLabels(): string[] {
    return this._done.map((command) => command.label);
  }

  /** The labels of the entries that can be redone, the next first. */
  get redoLabels(): string[] {
    return this._undone.map((command) => command.label).reverse();
  }

  /** Undoes the last entry; false when there is none. */
  undo(): boolean {
    if (!this.canUndo) {
      return false;
    }
    const command = this._done.pop() as Command;
    command.undo();
    this._undone.push(command);
    this._mergeable = false;
    this.changed();
    return true;
  }

  /** Redoes the last entry undone; false when there is none. */
  redo(): boolean {
    if (!this.canRedo) {
      return false;
    }
    const command = this._undone.pop() as Command;
    command.do();
    this._done.push(command);
    this._mergeable = false;
    this.changed();
    return true;
  }

  /** Forgets every entry (a new document). */
  clear(): void {
    for (const command of this._done) {
      command.dispose?.(false);
    }
    for (const command of this._undone) {
      command.dispose?.(true);
    }
    this._done.length = 0;
    this._undone.length = 0;
    this._mergeable = false;
    this.changed();
  }

  /** Calls `listener` after each change of the entries; returns a function that stops. */
  onChange(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index >= 0) {
        this._listeners.splice(index, 1);
      }
    };
  }

  private push(command: Command, mergeable: boolean): void {
    for (const undone of this._undone) {
      undone.dispose?.(true);
    }
    this._undone.length = 0;
    const last = this._done.at(-1);
    if (!(this._mergeable && mergeable && last?.merge?.(command))) {
      this._done.push(command);
      while (this._done.length > this.limit) {
        this._done.shift()?.dispose?.(false);
      }
    }
    this._mergeable = mergeable;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this._listeners]) {
      listener();
    }
  }
}
