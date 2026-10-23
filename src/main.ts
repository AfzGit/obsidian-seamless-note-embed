import { Plugin } from "obsidian";
import { OutlineIntegration } from "./outline";
import { EmbedHeadingProcessor, findRenderRoot } from "./processor";
import {
  AutoIncrementedEmbedHeadingsSettingTab,
  DEFAULT_SETTINGS,
  PluginSettings,
} from "./settings";

export default class AutoIncrementedEmbedHeadingsPlugin extends Plugin {
  settings!: PluginSettings;
  private processor!: EmbedHeadingProcessor;
  private outline!: OutlineIntegration;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.processor = new EmbedHeadingProcessor(this.app, () => this.settings);
    this.outline = new OutlineIntegration(this.app, () => this.settings);
    this.outline.start();

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
        this.outline.onLayoutChange();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.processor.refreshAll();
        this.outline.refresh();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.processor.refreshAll();
        this.outline.refresh();
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        // Keep the rendered outline keys in sync when the cache catches up
        // with an edit that added, removed, or reordered embeds.
        this.processor.refreshAll();
        this.outline.refresh();
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.processor.refreshAll();
        this.outline.refresh();
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
      this.outline.onLayoutChange();
    });
  }

  onunload(): void {
    this.outline?.destroy();
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
    this.outline.refresh();
  }

  reapplySettings(): void {
    this.refreshHeadingLevels();
    this.outline.onSettingsChanged();
  }
}
