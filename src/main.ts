import { Plugin } from "obsidian";
import { EmbedHeadingProcessor, findRenderRoot } from "./processor";
import {
  AutoIncrementedEmbedHeadingsSettingTab,
  DEFAULT_SETTINGS,
  PluginSettings,
} from "./settings";

export default class AutoIncrementedEmbedHeadingsPlugin extends Plugin {
  settings!: PluginSettings;
  private processor!: EmbedHeadingProcessor;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.processor = new EmbedHeadingProcessor(this.app, () => this.settings);

    this.registerMarkdownPostProcessor((element) => {
      if (!this.settings.enabled) {
        return;
      }

      const root = findRenderRoot(element);
      if (root) {
        this.processor.schedule(root);
      }
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.processor.refreshAll();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.processor.refreshAll();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.processor.refreshAll();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.settings.enabled && this.settings.livePreview) {
          this.processor.refreshActiveEditor();
        }
      }),
    );

    this.addCommand({
      id: "refresh-embedded-heading-levels",
      name: "Refresh embedded heading levels",
      callback: () => {
        this.refreshHeadingLevels();
      },
    });

    this.addSettingTab(new AutoIncrementedEmbedHeadingsSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.processor.refreshAll();
    });
  }

  onunload(): void {
    this.processor?.restoreAll();
    this.processor?.destroy();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Reset every heading to its source level, then apply the current settings
   * again. Used when a setting changes or the user asks for a manual refresh.
   */
  refreshHeadingLevels(): void {
    this.processor.restoreAll();
    this.processor.refreshAll();
  }

  reapplySettings(): void {
    this.refreshHeadingLevels();
  }
}
