/**
 * Folder path autocomplete suggestion.
 */

import { App, TFolder, AbstractInputSuggest } from "obsidian";

/**
 * Provides folder path suggestions for input fields.
 */
export class FolderSuggest extends AbstractInputSuggest<string> {
  private folderPaths: string[];
  private el: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.el = inputEl;
    this.folderPaths = app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map(f => f.path);
  }

  public override getSuggestions(query: string): string[] {
    return this.folderPaths.filter(path =>
      path.toLowerCase().includes(query.toLowerCase())
    );
  }

  public override renderSuggestion(path: string, el: HTMLElement): void {
    el.createEl("div", { text: path });
  }

  public override selectSuggestion(path: string): void {
    this.el.value = path;
    this.el.dispatchEvent(new Event("input"));
    this.close();
  }
}
