/**
 * File path autocomplete suggestion.
 */

import { App, TFile, AbstractInputSuggest } from "obsidian";

/**
 * Provides file path suggestions for input fields.
 */
export class FileSuggest extends AbstractInputSuggest<string> {
  private filePaths: string[];
  private el: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.el = inputEl;
    this.filePaths = app.vault.getAllLoadedFiles()
      .filter((f): f is TFile => f instanceof TFile)
      .map(f => f.path);
  }

  public override getSuggestions(query: string): string[] {
    return this.filePaths.filter(path =>
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
