import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  type KeybindingsManager,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  MAX_FREE_TEXT_LENGTH,
  type Question,
  type QuestionAnswer,
  type QuestionSelection,
  sanitizeDisplayText,
} from "./normalize.js";

export type DialogCancelReason = "cancelled" | "aborted" | "disposed" | "ui_error";

export type DialogOutcome =
  | { kind: "answered"; answers: QuestionAnswer[] }
  | { kind: "cancelled"; reason: DialogCancelReason; answers: QuestionAnswer[] };

type DialogRow = { kind: "option"; index: number } | { kind: "other" } | { kind: "done" } | { kind: "back" };

/**
 * Bordered, paged question dialog used only by the TUI execution path.
 * Every rendered line, including the embedded editor, is placed between the
 * same side frame and the DynamicBorder top/bottom rules.
 */
export class QuestionDialog implements Focusable {
  private readonly editor: Editor;
  private readonly editorTheme: EditorTheme;
  private readonly answers: (QuestionAnswer | undefined)[];
  private questionIndex = 0;
  private selectedRow = 0;
  private selectedOptions = new Set<number>();
  private editorMode = false;
  private settled = false;
  private isFocused = false;
  private editorAnswerSelections: QuestionSelection[] = [];

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly questions: readonly Question[];
  private readonly complete: (outcome: DialogOutcome) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    questions: readonly Question[],
    complete: (outcome: DialogOutcome) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.questions = questions;
    this.complete = complete;
    this.answers = new Array<QuestionAnswer | undefined>(questions.length).fill(undefined);
    this.editorTheme = {
      borderColor: (text) => this.theme.fg("borderAccent", text),
      selectList: getSelectListTheme(),
    };
    this.editor = new Editor(tui, this.editorTheme, { paddingX: 0 });
    this.editor.onSubmit = (text) => this.submitOther(text);
    this.beginQuestion();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.editor.focused = value && this.editorMode;
  }

  /** Resolve cancellation once even if Pi disposes a component after it completed. */
  dispose(): void {
    this.cancel("disposed");
  }

  cancel(reason: DialogCancelReason = "cancelled"): void {
    this.finish({ kind: "cancelled", reason, answers: this.partialAnswers() });
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.editorMode) {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.editorMode = false;
        this.editor.focused = false;
        this.editor.setText("");
        this.tui.requestRender();
        return;
      }
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.cancel("cancelled");
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedRow = Math.max(0, this.selectedRow - 1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedRow = Math.min(this.rows().length - 1, this.selectedRow + 1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedRow = Math.max(0, this.selectedRow - 5);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedRow = Math.min(this.rows().length - 1, this.selectedRow + 5);
    } else if (this.isMultiToggle(data)) {
      const row = this.rows()[this.selectedRow];
      if (row?.kind === "done" && this.keybindings.matches(data, "tui.select.confirm")) this.activateCurrentRow();
      else this.toggleCurrentOption();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.activateCurrentRow();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const innerWidth = Math.max(8, safeWidth - 4);
    const content = new Container();
    content.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));

    const question = this.questions[this.questionIndex];
    if (!question) {
      content.addChild(new Text(this.frame("No question is available.", safeWidth)));
      content.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
      return this.fitLines(content.render(safeWidth), safeWidth);
    }

    const progress = this.questions.length > 1 ? ` [${this.questionIndex + 1}/${this.questions.length}]` : "";
    content.addChild(
      new Text(this.frame(this.theme.bold(this.theme.fg("accent", `${question.header}${progress}`)), safeWidth)),
    );
    for (const line of this.wrapLines(question.question, innerWidth)) {
      content.addChild(new Text(this.frame(this.theme.fg("text", line), safeWidth)));
    }

    if (this.editorMode) {
      content.addChild(
        new Text(this.frame(this.theme.fg("dim", "Type your response, then press Enter to submit."), safeWidth)),
      );
      const editorWidth = Math.max(1, innerWidth);
      for (const line of this.editor.render(editorWidth)) {
        content.addChild(new Text(this.frame(line, safeWidth)));
      }
      content.addChild(new Text(this.frame(this.theme.fg("dim", "Esc cancel"), safeWidth)));
    } else {
      content.addChild(
        new Text(
          this.frame(
            this.theme.fg(
              "dim",
              question.multiSelect ? "Space/Enter toggle · choose Done when finished" : "Enter select · Esc cancel",
            ),
            safeWidth,
          ),
        ),
      );
      for (const [rowIndex, row] of this.rows().entries()) {
        const selected = rowIndex === this.selectedRow;
        const prefix = selected ? "❯ " : "  ";
        if (row.kind === "option") {
          const option = question.options[row.index];
          if (!option) continue;
          const checked = question.multiSelect ? (this.selectedOptions.has(row.index) ? "[x] " : "[ ] ") : "";
          const marker = this.theme.fg(selected ? "accent" : "border", prefix);
          const label = this.theme.fg(selected ? "accent" : "text", `${checked}${option.label}`);
          for (const line of this.wrapLines(`${marker}${label}`, innerWidth)) {
            content.addChild(new Text(this.frame(line, safeWidth)));
          }
          if (option.description) {
            for (const description of this.wrapLines(`    ${option.description}`, innerWidth)) {
              content.addChild(new Text(this.frame(this.theme.fg("muted", description), safeWidth)));
            }
          }
        } else if (row.kind === "other") {
          content.addChild(
            new Text(this.frame(this.theme.fg(selected ? "accent" : "text", `${prefix}Other (free text)`), safeWidth)),
          );
        } else if (row.kind === "done") {
          content.addChild(
            new Text(this.frame(this.theme.fg(selected ? "accent" : "success", `${prefix}Done`), safeWidth)),
          );
        } else {
          content.addChild(
            new Text(
              this.frame(
                this.theme.fg(selected ? "accent" : "dim", `${prefix}Back (revise previous answer)`),
                safeWidth,
              ),
            ),
          );
        }
      }
    }

    content.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
    return this.fitLines(content.render(safeWidth), safeWidth);
  }

  private rows(): DialogRow[] {
    const question = this.questions[this.questionIndex];
    if (!question) return [];
    const rows: DialogRow[] = question.options.map((_option, index) => ({ kind: "option", index }));
    if (question.allowOther) rows.push({ kind: "other" });
    if (question.multiSelect) rows.push({ kind: "done" });
    if (this.questions.length > 1 && this.questionIndex > 0) rows.push({ kind: "back" });
    return rows;
  }

  private beginQuestion(): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;
    this.editorMode = false;
    this.editor.focused = false;
    this.selectedOptions = new Set<number>();
    this.selectedRow = 0;
    const previous = this.answers[this.questionIndex];
    const selected = previous?.selected;
    const selections = selected === undefined ? [] : Array.isArray(selected) ? selected : [selected];
    for (const selection of selections) this.selectedOptions.add(selection.index);
    if (selections.length > 0 && !question.multiSelect) {
      this.selectedRow = Math.max(0, Math.min(question.options.length - 1, selections[0]?.index ?? 0));
    }
  }

  private activateCurrentRow(): void {
    const row = this.rows()[this.selectedRow];
    if (!row) return;
    if (row.kind === "option") {
      if (this.questions[this.questionIndex]?.multiSelect) this.toggleCurrentOption();
      else this.saveOptionAnswer(row.index);
    } else if (row.kind === "other") {
      this.beginOther();
    } else if (row.kind === "done") {
      this.saveMultiAnswer();
    } else {
      this.goBack();
    }
  }

  private isMultiToggle(data: string): boolean {
    const question = this.questions[this.questionIndex];
    const row = this.rows()[this.selectedRow];
    if (!question?.multiSelect || row?.kind !== "option") return false;
    return data === " " || matchesKey(data, Key.space) || this.keybindings.matches(data, "tui.select.confirm");
  }

  private toggleCurrentOption(): void {
    const row = this.rows()[this.selectedRow];
    if (row?.kind !== "option") return;
    if (this.selectedOptions.has(row.index)) this.selectedOptions.delete(row.index);
    else this.selectedOptions.add(row.index);
  }

  private beginOther(): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;
    this.editorAnswerSelections = [...this.selectedSelections()];
    this.editorMode = true;
    this.editor.setText("");
    this.editor.focused = this.isFocused;
  }

  private submitOther(text: string): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;
    const freeText = sanitizeDisplayText(text, MAX_FREE_TEXT_LENGTH);
    if (!freeText) return;
    const answer: QuestionAnswer = {
      id: question.id,
      header: question.header,
      question: question.question,
      ...(question.multiSelect ? { selected: this.editorAnswerSelections } : {}),
      freeText,
      wasCustom: true,
    };
    this.answers[this.questionIndex] = answer;
    this.advance();
  }

  private saveOptionAnswer(index: number): void {
    const question = this.questions[this.questionIndex];
    const option = question?.options[index];
    if (!question || !option) return;
    const selection: QuestionSelection = { label: option.label, value: option.value, index };
    this.answers[this.questionIndex] = {
      id: question.id,
      header: question.header,
      question: question.question,
      selected: selection,
      wasCustom: false,
    };
    this.advance();
  }

  private saveMultiAnswer(): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;
    this.answers[this.questionIndex] = {
      id: question.id,
      header: question.header,
      question: question.question,
      selected: this.selectedSelections(),
      wasCustom: false,
    };
    this.advance();
  }

  private selectedSelections(): QuestionSelection[] {
    const question = this.questions[this.questionIndex];
    if (!question) return [];
    return [...this.selectedOptions]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const option = question.options[index];
        return option ? [{ label: option.label, value: option.value, index }] : [];
      });
  }

  private advance(): void {
    if (this.questionIndex >= this.questions.length - 1) {
      this.finish({ kind: "answered", answers: this.completeAnswers() });
      return;
    }
    this.questionIndex += 1;
    this.beginQuestion();
  }

  private goBack(): void {
    if (this.questionIndex <= 0) return;
    this.answers[this.questionIndex] = undefined;
    this.questionIndex -= 1;
    this.answers[this.questionIndex] = undefined;
    this.beginQuestion();
  }

  private completeAnswers(): QuestionAnswer[] {
    return this.answers.filter((answer): answer is QuestionAnswer => answer !== undefined);
  }

  private partialAnswers(): QuestionAnswer[] {
    return this.completeAnswers();
  }

  private finish(outcome: DialogOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.editor.focused = false;
    this.complete(outcome);
  }

  private wrapLines(value: string, width: number): string[] {
    const lines = wrapTextWithAnsi(value, Math.max(1, width));
    return lines.length > 0 ? lines : [""];
  }

  private frame(value: string, width: number): string {
    const contentWidth = Math.max(1, width - 4);
    const text = truncateToWidth(value, contentWidth);
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(text)));
    return `${this.theme.fg("borderAccent", "│")} ${text}${padding} ${this.theme.fg("borderAccent", "│")}`;
  }

  private fitLines(lines: string[], width: number): string[] {
    return lines.map((line) => truncateToWidth(line, width));
  }
}
