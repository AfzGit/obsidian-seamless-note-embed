import { App, PluginSettingTab, Setting } from "obsidian";
import type AutoIncrementedEmbedHeadingsPlugin from "./main";

export interface PluginSettings {
  enabled: boolean;
  livePreview: boolean;
  hideEmbedLine: boolean;
  hideEmbedIndent: boolean;
  hideEmbedTitle: boolean;
  hideEmbedScrollbar: boolean;
  hideEmbedOpenButton: boolean;
  removeEmbedLimit: boolean;
  justifyPreviewText: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: true,
  livePreview: true,
  hideEmbedLine: false,
  hideEmbedIndent: false,
  hideEmbedTitle: false,
  hideEmbedScrollbar: false,
  hideEmbedOpenButton: false,
  removeEmbedLimit: false,
  justifyPreviewText: false,
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

    containerEl.createEl("h2", { text: "Seamless Note Embed" });

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

    containerEl.createEl("h3", { text: "Embed appearance" });

    new Setting(containerEl)
      .setName("Hide embed left line")
      .setDesc(
        "Remove the colored line Obsidian draws on the left side of embedded notes. Hover previews are unaffected.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideEmbedLine).onChange(async (value) => {
          this.plugin.settings.hideEmbedLine = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Remove embed indentation")
      .setDesc(
        "Remove the extra left padding and indentation guides from embedded note content. Only embeds in notes are affected; hover previews keep their normal indentation.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideEmbedIndent).onChange(async (value) => {
          this.plugin.settings.hideEmbedIndent = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Hide embedded note filename")
      .setDesc(
        "Hide the filename shown above embedded notes. Hover previews are unaffected.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideEmbedTitle).onChange(async (value) => {
          this.plugin.settings.hideEmbedTitle = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Hide embed scrollbar")
      .setDesc(
        "Hide the scrollbar on the right side of embedded notes while keeping them scrollable with the mouse wheel or trackpad. Hover previews are unaffected.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideEmbedScrollbar).onChange(async (value) => {
          this.plugin.settings.hideEmbedScrollbar = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Hide embed open-note button")
      .setDesc(
        "Hide the open-note button in the top-right corner of embedded notes. Hover previews are unaffected.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideEmbedOpenButton).onChange(async (value) => {
          this.plugin.settings.hideEmbedOpenButton = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Remove embed height limit")
      .setDesc(
        "Let long embedded notes expand to their full height in Reading View and Live Preview instead of stopping at Obsidian's height limit. Hover previews are unaffected.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.removeEmbedLimit).onChange(async (value) => {
          this.plugin.settings.removeEmbedLimit = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Justify text in Reading View")
      .setDesc(
        "Justify paragraphs, list items, table cells, and blockquotes in Reading View, including text inside embedded notes.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.justifyPreviewText).onChange(async (value) => {
          this.plugin.settings.justifyPreviewText = value;
          await this.plugin.saveSettings();
          this.plugin.applyAppearanceSettings();
        }),
      );
  }
}
