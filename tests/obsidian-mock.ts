export class TFile {
  constructor(public path: string) {}
  get extension(): string {
    return this.path.split('.').pop() ?? '';
  }
}
export class TFolder {
  constructor(public path: string) {}
}
export class Notice {
  constructor(_message: string) {}
}
export class Modal {}
export class Menu {}
export class Setting {}
export class PluginSettingTab {
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
