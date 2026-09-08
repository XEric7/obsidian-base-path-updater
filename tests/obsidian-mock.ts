export class TFile {
  constructor(public path: string) {}
  get extension(): string {
    return this.path.split('.').pop() ?? '';
  }
}
export class TFolder {
  constructor(public path: string) {}
}
/** Captures notification text without displaying a native popup. */
export class Notice {
  static messages: string[] = [];
  /** Records the supplied notification message. */
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

/** Minimal UI text sink for exercising modal and legacy setting rendering without a browser. */
export class TestElement {
  texts: string[] = [];
  buttons: TestButton[] = [];
  /** Clears captured text and buttons. */
  empty(): void {
    this.texts.length = 0;
    this.buttons.length = 0;
  }
  /** Accepts a CSS class without affecting text capture. */
  addClass(_name: string): void {}
  /** Captures the supplied element text and returns this shared rendering sink. */
  createEl(_tag: string, options: { text?: string; cls?: string } = {}): TestElement {
    if (options.text !== undefined) this.texts.push(options.text);
    return this;
  }
  /** Accepts a div's options and returns the shared sink. */
  createDiv(options: { cls?: string } = {}): TestElement {
    return this.createEl('div', options);
  }
  /** Captures a span's text and returns the shared sink. */
  createSpan(options: { text?: string }): TestElement {
    return this.createEl('span', options);
  }
}

/** Captures a rendered button label, disabled state, and click handler. */
export class TestButton {
  text = '';
  disabled = false;
  click: () => unknown = () => {};
  /** Stores the supplied label and returns this button for chaining. */
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  /** Stores the supplied disabled state and returns this button. */
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  /** Stores the supplied activation callback and returns this button. */
  onClick(callback: () => unknown): this {
    this.click = callback;
    return this;
  }
}

/** Provides a text sink for modal rendering tests. */
export class Modal {
  contentEl = new TestElement();
  /** Accepts the app binding used by the real Obsidian modal. */
  constructor(_app: unknown) {}
  /** Provides an overridable modal-open hook. */
  onOpen(): void {}
  /** Invokes the subclass render hook. */
  open(): void {
    this.onOpen();
  }
}
export class Menu {}
/** Captures setting labels and buttons in the supplied UI sink. */
export class Setting {
  /** Binds the setting row to its supplied rendering sink. */
  constructor(private container: TestElement) {}
  /** Captures a supplied setting name and returns this row. */
  setName(text: string): this {
    this.container.texts.push(text);
    return this;
  }
  /** Captures a supplied description and returns this row. */
  setDesc(text: string): this {
    this.container.texts.push(text);
    return this;
  }
  /** Configures and records a button using the supplied callback, then returns this row. */
  addButton(callback: (button: TestButton) => unknown): this {
    const button = new TestButton();
    callback(button);
    this.container.buttons.push(button);
    return this;
  }
}
export class PluginSettingTab {
  containerEl = new TestElement();
  constructor(_app: unknown, _plugin: unknown) {}
}
export class Plugin {
  app: unknown;
  persisted: unknown = null;
  failSave = false;
  saved: unknown[] = [];
  async loadData() {
    return this.persisted;
  }
  async saveData(data: unknown) {
    if (this.failSave) throw new Error('Disk full');
    this.persisted = structuredClone(data);
    this.saved.push(this.persisted);
  }
  registerEvent() {}
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
}
/** Returns the default test app language; individual language tests can spy on this export. */
export function getLanguage(): string {
  return 'en';
}
