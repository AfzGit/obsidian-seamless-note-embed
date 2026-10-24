import {
  App,
  PluginSettingTab,
  Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";
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

type BooleanSettingKey = {
  [K in keyof PluginSettings]: PluginSettings[K] extends boolean ? K : never;
}[keyof PluginSettings];

interface SettingRow {
  name: string;
  desc: string;
  addControl: (setting: Setting) => void;
}

export class AutoIncrementedEmbedHeadingsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AutoIncrementedEmbedHeadingsPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    for (const row of this.generalRows()) {
      this.renderRow(containerEl, row);
    }

    new Setting(containerEl).setName("Embed appearance").setHeading();

    for (const row of this.appearanceRows()) {
      this.renderRow(containerEl, row);
    }
  }

  /**
   * Obsidian 1.13+ uses this declarative form, which also makes every setting
   * searchable. Older versions fall back to `display()`.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      ...this.generalRows().map((row) => this.definition(row)),
      {
        type: "group",
        heading: "Embed appearance",
        items: this.appearanceRows().map((row) => this.definition(row)),
      },
    ];
  }

  private renderRow(containerEl: HTMLElement, row: SettingRow): void {
    const setting = new Setting(containerEl)
      .setName(row.name)
      .setDesc(row.desc);
    row.addControl(setting);
  }

  private definition(row: SettingRow): SettingDefinition {
    return {
      name: row.name,
      desc: row.desc,
      render: (setting) => {
        row.addControl(setting);
      },
    };
  }

  private generalRows(): SettingRow[] {
    return [
      this.toggleRow(
        "Enable heading level shifting",
        "Shift the headings of embedded notes so they nest under the heading that contains the embed.",
        "enabled",
        () => this.plugin.reapplySettings(),
      ),
      this.toggleRow(
        "Apply in live preview",
        "Also shift embeds while editing in live preview. Reading view is always supported when the plugin is enabled.",
        "livePreview",
        () => this.plugin.reapplySettings(),
      ),
      {
        name: "Refresh now",
        desc: "Re-apply heading shifts to every open note.",
        addControl: (setting) => {
          setting.addButton((button) =>
            button.setButtonText("Refresh").onClick(() => {
              this.plugin.refreshHeadingLevels();
            }),
          );
        },
      },
    ];
  }

  private appearanceRows(): SettingRow[] {
    return [
      this.toggleRow(
        "Hide embed left line",
        "Remove the colored line Obsidian draws on the left side of embedded notes. Hover previews are unaffected.",
        "hideEmbedLine",
        () => this.plugin.applyAppearanceSettings(),
      ),
      this.toggleRow(
        "Remove embed indentation",
        "Remove the extra left padding and indentation guides from embedded note content. Only embeds in notes are affected; hover previews keep their normal indentation.",
        "hideEmbedIndent",
        () => this.plugin.applyAppearanceSettings(),
      ),
      this.toggleRow(
        "Hide embedded note filename",
        "Hide the filename shown above embedded notes. Hover previews are unaffected.",
        "hideEmbedTitle",
        () => this.plugin.applyAppearanceSettings(),
      ),
      this.toggleRow(
        "Hide embed scrollbar",
        "Hide the scrollbar on the right side of embedded notes while keeping them scrollable with the mouse wheel or trackpad. Hover previews are unaffected.",
        "hideEmbedScrollbar",
        () => this.plugin.applyAppearanceSettings(),
      ),
      this.toggleRow(
        "Hide embed open-note button",
        "Hide the open-note button in the top-right corner of embedded notes. Hover previews are unaffected.",
        "hideEmbedOpenButton",
        () => this.plugin.applyAppearanceSettings(),
      ),
      this.toggleRow(
        "Remove embed height limit",
        "Let long embedded notes expand to their full height in reading view and live preview instead of stopping at Obsidian's height limit. Hover previews are unaffected.",
        "removeEmbedLimit",
        () => this.plugin.applyAppearanceSettings(),
      ),
      this.toggleRow(
        "Justify text in reading view",
        "Justify paragraphs, list items, table cells, and blockquotes in reading view, including text inside embedded notes.",
        "justifyPreviewText",
        () => this.plugin.applyAppearanceSettings(),
      ),
    ];
  }

  private toggleRow(
    name: string,
    desc: string,
    key: BooleanSettingKey,
    afterChange: () => void,
  ): SettingRow {
    return {
      name,
      desc,
      addControl: (setting) => {
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value;
              await this.plugin.saveSettings();
              afterChange();
            }),
        );
      },
    };
  }
}
