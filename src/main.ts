import { Notice, Plugin } from "obsidian";
import { MetadataHeadingIntegration } from "./metadataHeadings";
import { HeadingNavigationBridge } from "./navigationBridge";
import { OutlineIntegration } from "./outline";
import { EmbedHeadingProcessor, findRenderRoot } from "./processor";
import { ThirdPartyOutlineIntegration } from "./thirdPartyOutlines";
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
  hideEmbedScrollbar: {
    className: "aeih-hide-embed-scrollbar",
    printFlag: "--aeih-print-hide-embed-scrollbar",
  },
  hideEmbedOpenButton: {
    className: "aeih-hide-embed-open-button",
    printFlag: "--aeih-print-hide-embed-open-button",
  },
  removeEmbedLimit: {
    className: "aeih-remove-embed-limit",
    printFlag: "--aeih-print-remove-embed-limit",
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
  private metadataHeadings!: MetadataHeadingIntegration;
  private navigationBridge!: HeadingNavigationBridge;
  private thirdPartyOutlines!: ThirdPartyOutlineIntegration;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyAppearanceSettings();

    this.metadataHeadings = new MetadataHeadingIntegration(this.app, () => ({
      enabled: this.settings.pluginEnabled,
      shift: this.settings.enabled,
    }));
    this.metadataHeadings.start();

    this.navigationBridge = new HeadingNavigationBridge(
      this.app,
      this.metadataHeadings,
    );
    if (this.settings.pluginEnabled) {
      this.navigationBridge.start();
    }

    this.processor = new EmbedHeadingProcessor(this.app, () => ({
      enabled: this.headingShiftingEnabled,
      livePreview: this.livePreviewEnabled,
    }));
    this.outline = new OutlineIntegration(this.app, () => ({
      enabled: this.settings.pluginEnabled,
      shift: this.settings.enabled,
    }));
    if (this.settings.pluginEnabled) {
      this.outline.start();
    }

    this.thirdPartyOutlines = new ThirdPartyOutlineIntegration(
      this.app,
      this.metadataHeadings,
      (file, line) => this.navigationBridge.navigateToLine(file, line),
    );
    if (this.settings.pluginEnabled) {
      this.thirdPartyOutlines.start();
    }

    this.registerMarkdownPostProcessor((element) => {
      if (!this.headingShiftingEnabled) {
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
        this.navigationBridge.onLayoutChange();
        this.outline.onLayoutChange();
        this.thirdPartyOutlines.onLayoutChange();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.processor.refreshAll();
        this.navigationBridge.onLayoutChange();
        this.outline.refresh();
        this.thirdPartyOutlines.onLayoutChange();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.processor.refreshAll();
        this.navigationBridge.onLayoutChange();
        this.outline.refresh();
        this.thirdPartyOutlines.onLayoutChange();
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        // Keep the rendered outline keys in sync when the cache catches up
        // with an edit that added, removed, or reordered embeds.
        this.metadataHeadings.refresh();
        this.navigationBridge.refresh();
        this.processor.refreshAll();
        this.outline.refresh();
        this.thirdPartyOutlines.refresh();
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.metadataHeadings.refresh();
        this.navigationBridge.refresh();
        this.processor.refreshAll();
        this.outline.refresh();
        this.thirdPartyOutlines.refresh();
      }),
    );

    // Clear the virtual-heading cache before Obsidian emits metadata changes.
    // That way Quiet Outline and Subtle TOC never read a stale augmented
    // cache during their own "changed" handlers.
    this.registerEvent(
      this.app.vault.on("modify", () => {
        this.metadataHeadings.refresh();
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", () => {
        this.metadataHeadings.refresh();
        this.navigationBridge.refresh();
        this.thirdPartyOutlines.refresh();
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", () => {
        this.metadataHeadings.refresh();
        this.navigationBridge.refresh();
        this.thirdPartyOutlines.refresh();
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", () => {
        this.metadataHeadings.refresh();
        this.navigationBridge.refresh();
        this.thirdPartyOutlines.refresh();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.headingShiftingEnabled && this.settings.livePreview) {
          this.processor.refreshActiveEditor();
        }
      }),
    );

    this.addCommand({
      id: "toggle-plugin",
      name: "Toggle plugin on/off",
      callback: () => {
        void this.togglePlugin();
      },
    });

    this.addCommand({
      id: "toggle-heading-increments",
      name: "Toggle heading increments on/off",
      callback: () => {
        void this.toggleHeadingIncrements();
      },
    });

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
      this.navigationBridge.onLayoutChange();
      this.outline.onLayoutChange();
      this.thirdPartyOutlines.onLayoutChange();
    });
  }

  onunload(): void {
    this.clearAppearanceSettings();
    // Restore the navigation hooks before the metadata cache, then let the
    // third-party integrations refresh against the real headings.
    this.navigationBridge?.destroy();
    this.metadataHeadings?.destroy();
    this.thirdPartyOutlines?.destroy();
    this.outline?.destroy();
    this.processor?.restoreAll();
    this.processor?.destroy();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Heading shifts require both the master switch and the shifting switch. */
  get headingShiftingEnabled(): boolean {
    return this.settings.pluginEnabled && this.settings.enabled;
  }

  get livePreviewEnabled(): boolean {
    return this.headingShiftingEnabled && this.settings.livePreview;
  }

  async togglePlugin(): Promise<void> {
    this.settings.pluginEnabled = !this.settings.pluginEnabled;
    await this.saveSettings();
    this.reapplySettings();
    new Notice(
      `Seamless Note Embed ${this.settings.pluginEnabled ? "enabled" : "disabled"}.`,
    );
  }

  async toggleHeadingIncrements(): Promise<void> {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    this.reapplySettings();
    new Notice(
      `Heading level shifting ${this.settings.enabled ? "enabled" : "disabled"}.`,
    );
  }

  /**
   * Reset every heading to its source level, then apply the current settings
   * again. Used when a setting changes or the user asks for a manual refresh.
   */
  refreshHeadingLevels(): void {
    this.metadataHeadings.refresh();
    this.navigationBridge.refresh();
    this.processor.restoreAll();
    this.processor.refreshAll();
    this.outline.refresh();
    this.thirdPartyOutlines.refresh();
  }

  /**
   * Apply the CSS-only appearance options. These are intentionally separate
   * from heading shifting so they can be used without changing heading levels.
   */
  applyAppearanceSettings(): void {
    if (!this.settings.pluginEnabled) {
      this.clearAppearanceSettings();
      return;
    }

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
      APPEARANCE_OPTIONS.hideEmbedScrollbar,
      this.settings.hideEmbedScrollbar,
    );
    this.applyAppearanceOption(
      body,
      APPEARANCE_OPTIONS.hideEmbedOpenButton,
      this.settings.hideEmbedOpenButton,
    );
    this.applyAppearanceOption(
      body,
      APPEARANCE_OPTIONS.removeEmbedLimit,
      this.settings.removeEmbedLimit,
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
      body.setCssProps({ [option.printFlag]: "1" });
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
    this.metadataHeadings.onSettingsChanged();

    // Outline entries and navigation are useful even when heading increments
    // are off; they simply use the embedded notes' original levels. Only the
    // master switch stops these integrations.
    if (this.settings.pluginEnabled) {
      this.navigationBridge.start();
      this.thirdPartyOutlines.start();
    } else {
      this.navigationBridge.stop();
      this.thirdPartyOutlines.stop();
    }

    this.processor.restoreAll();
    this.processor.refreshAll();
    this.outline.onSettingsChanged();
  }
}
