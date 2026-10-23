import { App, PluginSettingTab, Setting } from "obsidian";
import type AutoIncrementedEmbedHeadingsPlugin from "./main";

export interface PluginSettings {
  enabled: boolean;
  livePreview: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: true,
  livePreview: true,
};

export class AutoIncrementedEmbedHeadingsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AutoIncrementedEmbedHeadingsPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Auto-incremented embed headings" });

    new Setting(containerEl)
      .setName("Enable heading level shifting")
      .setDesc(
        "Shift the headings of embedded notes so they nest under the heading that contains the embed.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.reapplySettings();
        }),
      );

    new Setting(containerEl)
      .setName("Apply in Live Preview")
      .setDesc(
        "Also shift embeds while editing in Live Preview. Reading View is always supported when the plugin is enabled.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.livePreview).onChange(async (value) => {
          this.plugin.settings.livePreview = value;
          await this.plugin.saveSettings();
          this.plugin.reapplySettings();
        }),
      );

    new Setting(containerEl)
      .setName("Refresh now")
      .setDesc("Re-apply heading shifts to every open note.")
      .addButton((button) =>
        button.setButtonText("Refresh").onClick(() => {
          this.plugin.refreshHeadingLevels();
        }),
      );
  }
}
