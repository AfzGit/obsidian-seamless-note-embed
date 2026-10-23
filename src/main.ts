import { Plugin } from "obsidian";
import { OutlineIntegration } from "./outline";
import { EmbedHeadingProcessor, findRenderRoot } from "./processor";
import {
  AutoIncrementedEmbedHeadingsSettingTab,
  DEFAULT_SETTINGS,
  PluginSettings,
} from "./settings";

const APPEARANCE_OPTIONS = {
  hideEmbedLine: {
    className: "aeih-hide-embed-line",
    printFlag: "--aeih-print-hide-embed-line",
  },
  hideEmbedIndent: {
    className: "aeih-hide-embed-indent",
    printFlag: "--aeih-print-hide-embed-indent",
  },
  hideEmbedTitle: {
    className: "aeih-hide-embed-title",
    printFlag: "--aeih-print-hide-embed-title",
  },
  justifyPreviewText: {
    className: "aeih-justify-preview",
    printFlag: "--aeih-print-justify-preview",
  },
} as const;

export default class AutoIncrementedEmbedHeadingsPlugin extends Plugin {
  settings!: PluginSettings;
  private processor!: EmbedHeadingProcessor;
  private outline!: OutlineIntegration;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyAppearanceSettings();

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
    this.clearAppearanceSettings();
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

  /**
   * Apply the CSS-only appearance options. These are intentionally separate
   * from heading shifting so they can be used without changing heading levels.
   */
  applyAppearanceSettings(): void {
    if (typeof document === "undefined" || !document.body) {
      return;
    }

    const body = document.body;
    this.applyAppearanceOption(
      body,
      APPEARANCE_OPTIONS.hideEmbedLine,
      this.settings.hideEmbedLine,
    );
    this.applyAppearanceOption(
      body,
      APPEARANCE_OPTIONS.hideEmbedIndent,
      this.settings.hideEmbedIndent,
    );
    this.applyAppearanceOption(
      body,
      APPEARANCE_OPTIONS.hideEmbedTitle,
      this.settings.hideEmbedTitle,
    );
    this.applyAppearanceOption(
      body,
      APPEARANCE_OPTIONS.justifyPreviewText,
      this.settings.justifyPreviewText,
    );
  }

  private applyAppearanceOption(
    body: HTMLElement,
    option: { className: string; printFlag: string },
    enabled: boolean,
  ): void {
    body.classList.toggle(option.className, enabled);
    if (enabled) {
      body.style.setProperty(option.printFlag, "1");
    } else {
      body.style.removeProperty(option.printFlag);
    }
  }

  private clearAppearanceSettings(): void {
    if (typeof document === "undefined" || !document.body) {
      return;
    }

    for (const option of Object.values(APPEARANCE_OPTIONS)) {
      document.body.classList.remove(option.className);
      document.body.style.removeProperty(option.printFlag);
    }
  }

  reapplySettings(): void {
    this.applyAppearanceSettings();
    this.refreshHeadingLevels();
    this.outline.onSettingsChanged();
  }
}
