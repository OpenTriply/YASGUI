/**
 * Make sure not to include any deps from our main index file. That way, we can easily publish the plugin as standalone build
 */
require("./index.scss");
require("datatables.net-dt/css/jquery.dataTables.css");
require("datatables.net");
//@ts-ignore (jquery _does_ expose a default. In es6, it's the one we should use)
import $ from "jquery";
import Parser from "../../parsers";
import { escape } from "lodash-es";
import { Plugin, DownloadInfo } from "../";
import Yasr from "../../";
import { drawSvgStringAsElement, drawFontAwesomeIconAsSvg, addClass, removeClass } from "@triply/yasgui-utils";
import * as faTableIcon from "@fortawesome/free-solid-svg-icons/faTable";
import { DeepReadonly } from "ts-essentials";
import { cloneDeep } from "lodash-es";

const ColumnResizer = require("column-resizer");
const DEFAULT_PAGE_SIZE = 50;

export interface PluginConfig {
  openIriInNewWindow: boolean;
  tableConfig: DataTables.Settings;
  ellipseLength: number;
}

export interface PersistentConfig {
  pageSize?: number;
  compact?: boolean;
}

type DataRow = [number, ...(Parser.BindingValue | "")[]];

export default class Table implements Plugin<PluginConfig> {
  private config: DeepReadonly<PluginConfig>;
  private persistentConfig: PersistentConfig = {};
  private yasr: Yasr;
  private tableControls: Element | undefined;
  private dataTable: DataTables.Api | undefined;
  private tableFilterField: HTMLInputElement | undefined;
  private tableSizeField: HTMLSelectElement | undefined;
  private tableCompactSwitch: HTMLInputElement | undefined;
  private expandedCells: { [rowCol: string]: boolean | undefined } = {};
  private tableResizer: { reset: (options: { disable: boolean }) => void } | undefined;
  public helpReference = "https://triply.cc/docs/yasgui#table";
  public label = "Table";
  public priority = 10;
  public getIcon() {
    return drawSvgStringAsElement(drawFontAwesomeIconAsSvg(faTableIcon));
  }
  constructor(yasr: Yasr) {
    this.yasr = yasr;
    //TODO read options from constructor
    this.config = Table.defaults;
  }
  public static defaults: PluginConfig = {
    openIriInNewWindow: true,
    ellipseLength: 30,
    tableConfig: {
      dom: "tip", //  tip: Table, Page Information and Pager, change to ipt for showing pagination on top
      pageLength: DEFAULT_PAGE_SIZE, //default page length
      lengthChange: true, //allow changing page length
      data: [],
      columns: [],
      order: [],
      deferRender: true,
      orderClasses: false,
      language: {
        paginate: {
          first: "&lt;&lt;", // Have to specify these two due to TS defs, <<
          last: "&gt;&gt;", // Have to specify these two due to TS defs, >>
          next: "&gt;", // >
          previous: "&lt;", // <
        },
      },
    },
  };
  private getRows(): DataRow[] {
    if (!this.yasr.results) return [];
    const bindings = this.yasr.results.getBindings();
    if (!bindings) return [];
    // Vars decide the columns
    const vars = this.yasr.results.getVariables();
    // Use "" as the empty value, undefined will throw runtime errors
    return bindings.map((binding, rowId) => [rowId + 1, ...vars.map((variable) => binding[variable] ?? "")]);
  }

  private getUriLinkFromBinding(binding: Parser.BindingValue, prefixes?: { [key: string]: string }) {
    const href = binding.value;
    let visibleString = href;
    let prefixed = false;
    if (prefixes) {
      for (const prefixLabel in prefixes) {
        if (visibleString.indexOf(prefixes[prefixLabel]) == 0) {
          visibleString = prefixLabel + ":" + href.substring(prefixes[prefixLabel].length);
          prefixed = true;
          break;
        }
      }
    }
    // Hide brackets when prefixed or compact
    const hideBrackets = prefixed || this.persistentConfig.compact;
    return `${hideBrackets ? "" : "&lt;"}<a class='iri' target='${
      this.config.openIriInNewWindow ? '_blank ref="noopener noreferrer"' : "_self"
    }' href='${href}'>${visibleString}</a>${hideBrackets ? "" : "&gt;"}`;
  }
  private getCellContent(
    binding: Parser.BindingValue,
    prefixes?: { [label: string]: string },
    options?: { ellipse?: boolean }
  ): string {
    let content: string;
    if (binding.type == "uri") {
      content = this.getUriLinkFromBinding(binding, prefixes);
    } else {
      content = `<span class='nonIri'>${this.formatLiteral(binding, prefixes, options)}</span>`;
    }
    return `<div>${content}</div>`;
  }
  private formatLiteral(
    literalBinding: Parser.BindingValue,
    prefixes?: { [key: string]: string },
    options?: { ellipse?: boolean }
  ) {
    let stringRepresentation = literalBinding.value;
    const shouldEllipse = options?.ellipse ?? true;
    // make sure we don't do an ellipsis for just one character
    if (shouldEllipse && stringRepresentation.length > this.config.ellipseLength + 1) {
      const ellipseSize = this.config.ellipseLength / 2;
      stringRepresentation = `${escape(
        stringRepresentation.slice(0, ellipseSize)
      )}<a class="tableEllipse" title="Click to expand">…</a>${escape(stringRepresentation.slice(-1 * ellipseSize))}`;
    } else {
      stringRepresentation = escape(stringRepresentation);
    }
    // Return now when in compact mode.
    if (this.persistentConfig.compact) return stringRepresentation;

    if (literalBinding["xml:lang"]) {
      stringRepresentation = `"${stringRepresentation}"<sup>@${literalBinding["xml:lang"]}</sup>`;
    } else if (literalBinding.datatype) {
      const dataType = this.getUriLinkFromBinding({ type: "uri", value: literalBinding.datatype }, prefixes);
      stringRepresentation = `"${stringRepresentation}"<sup>^^${dataType}</sup>`;
    }
    return stringRepresentation;
  }

  private getColumns(): DataTables.ColumnSettings[] {
    if (!this.yasr.results) return [];
    const prefixes = this.yasr.getPrefixes();

    return [
      {
        name: "",
        searchable: false,
        width: `${this.getSizeFirstColumn()}px`,
        type: "num",
        orderable: false,
        visible: this.persistentConfig.compact !== true,
        render: (data: number, type: any) =>
          type === "filter" || type === "sort" || !type ? data : `<div class="rowNumber">${data}</div>`,
      }, //prepend with row numbers column
      ...this.yasr.results?.getVariables().map((name) => {
        return <DataTables.ColumnSettings>{
          name: name,
          title: name,
          render: (data: Parser.BindingValue | "", type: any, _row: any, meta: DataTables.CellMetaSettings) => {
            // Handle empty rows
            if (data === "") return data;
            if (type === "filter" || type === "sort" || !type) return data.value;
            // Check if we need to show the ellipsed version
            if (this.expandedCells[`${meta.row}-${meta.col}`]) {
              return this.getCellContent(data, prefixes, { ellipse: false });
            }
            return this.getCellContent(data, prefixes);
          },
          createdCell: (cell: Node, cellData: Parser.BindingValue | "", _rowData: any, row: number, col: number) => {
            // Do nothing on empty cells
            if (cellData === "") return;
            // Ellipsis is only applied on literals variants
            if (cellData.type === "literal" || cellData.type === "typed-literal") {
              const ellipseEl = (cell as HTMLTableDataCellElement).querySelector(".tableEllipse");
              if (ellipseEl)
                ellipseEl.addEventListener("click", () => {
                  this.expandedCells[`${row}-${col}`] = true;
                  // Disable the resizer as it messes with the initial drawing
                  this.tableResizer?.reset({ disable: true });
                  // Make the table redraw the cell
                  this.dataTable?.cell(row, col).invalidate();
                  // Signal the table to redraw the width of the table
                  this.dataTable?.columns.adjust();
                });
            }
          },
        };
      }),
    ];
  }
  private getSizeFirstColumn() {
    const numResults = this.yasr.results?.getBindings()?.length || 0;
    return numResults.toString().length * 5;
  }

  public draw(persistentConfig: PersistentConfig) {
    this.persistentConfig = { ...this.persistentConfig, ...persistentConfig };
    const table = document.createElement("table");
    const rows = this.getRows();
    const columns = this.getColumns();
    this.expandedCells = {};
    if (rows.length <= (persistentConfig?.pageSize || DEFAULT_PAGE_SIZE)) {
      this.yasr.pluginControls;
      addClass(this.yasr.rootEl, "isSinglePage");
    } else {
      removeClass(this.yasr.rootEl, "isSinglePage");
    }

    if (this.dataTable) {
      // Resizer needs to be disabled otherwise it will mess with the new table's width
      this.tableResizer?.reset({ disable: true });
      this.tableResizer = undefined;

      this.dataTable.destroy(true);
      this.dataTable = undefined;
    }
    this.yasr.resultsEl.appendChild(table);
    // reset some default config properties as they couldn't be initialized beforehand
    const dtConfig: DataTables.Settings = {
      ...((cloneDeep(this.config.tableConfig) as unknown) as DataTables.Settings),
      pageLength: persistentConfig?.pageSize ? persistentConfig.pageSize : DEFAULT_PAGE_SIZE,
      data: rows,
      columns: columns,
    };
    this.dataTable = $(table).DataTable(dtConfig);
    table.style.width = "unset";
    this.tableResizer = new ColumnResizer.default(table, {
      widths: this.persistentConfig.compact === true ? [] : [this.getSizeFirstColumn()],
      partialRefresh: true,
    });
    // Expanding an ellipsis disables the resizing, wait for the signal to re-enable it again
    this.dataTable.on("column-sizing", () => this.enableResizer());
    this.drawControls();
  }

  private handleTableSearch = (event: KeyboardEvent) => {
    this.dataTable?.search((event.target as HTMLInputElement).value).draw();
  };
  private handleTableSizeSelect = (event: Event) => {
    const pageLength = parseInt((event.target as HTMLSelectElement).value);
    // Set page length
    this.dataTable?.page.len(pageLength).draw();
    // Store in persistentConfig
    this.persistentConfig.pageSize = pageLength;
    this.yasr.storePluginConfig("table", this.persistentConfig);
  };
  private handleSetCompactToggle = (event: Event) => {
    // Store in persistentConfig
    this.persistentConfig.compact = (event.target as HTMLInputElement).checked;
    // Update the table
    this.yasr.storePluginConfig("table", this.persistentConfig);
    this.draw(this.persistentConfig);
  };
  /**
   * Draws controls on each update
   */
  drawControls() {
    // Remove old header
    this.removeControls();
    this.tableControls = document.createElement("div");
    this.tableControls.className = "tableControls";

    // Compact switch
    const toggleWrapper = document.createElement("div");
    const switchComponent = document.createElement("label");
    const textComponent = document.createElement("span");
    textComponent.innerText = "Compact";
    addClass(textComponent, "label");
    switchComponent.appendChild(textComponent);
    addClass(switchComponent, "switch");
    toggleWrapper.appendChild(switchComponent);
    this.tableCompactSwitch = document.createElement("input");
    switchComponent.addEventListener("change", this.handleSetCompactToggle);
    this.tableCompactSwitch.type = "checkbox";
    switchComponent.appendChild(this.tableCompactSwitch);
    this.tableCompactSwitch.defaultChecked = !!this.persistentConfig.compact;
    this.tableControls.appendChild(toggleWrapper);

    // Create table filter
    this.tableFilterField = document.createElement("input");
    this.tableFilterField.className = "tableFilter";
    this.tableFilterField.placeholder = "Filter query results";
    this.tableControls.appendChild(this.tableFilterField);
    this.tableFilterField.addEventListener("keyup", this.handleTableSearch);

    // Create page wrapper
    const pageSizerWrapper = document.createElement("div");
    pageSizerWrapper.className = "pageSizeWrapper";

    // Create label for page size element
    const pageSizerLabel = document.createElement("span");
    pageSizerLabel.textContent = "Page size: ";
    pageSizerLabel.className = "pageSizerLabel";
    pageSizerWrapper.appendChild(pageSizerLabel);

    // Create page size element
    this.tableSizeField = document.createElement("select");
    this.tableSizeField.className = "tableSizer";

    // Create options for page sizer
    const options = [10, 50, 100, 1000, -1];
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option + "";
      // -1 selects everything so we should call it All
      element.innerText = option > 0 ? option + "" : "All";
      // Set initial one as selected
      if (this.dataTable?.page.len() === option) element.selected = true;
      this.tableSizeField.appendChild(element);
    }
    pageSizerWrapper.appendChild(this.tableSizeField);
    this.tableSizeField.addEventListener("change", this.handleTableSizeSelect);
    this.tableControls.appendChild(pageSizerWrapper);
    this.yasr.pluginControls.appendChild(this.tableControls);
  }
  download(filename?: string) {
    return {
      getData: () => this.yasr.results?.asCsv() || "",
      contentType: "text/csv",
      title: "Download result",
      filename: `${filename || "queryResults"}.csv`,
    } as DownloadInfo;
  }

  public canHandleResults() {
    return !!this.yasr.results && this.yasr.results.getVariables() && this.yasr.results.getVariables().length > 0;
  }
  private removeControls() {
    // Unregister listeners and remove references to old fields
    this.tableFilterField?.removeEventListener("keyup", this.handleTableSearch);
    this.tableFilterField = undefined;
    this.tableSizeField?.removeEventListener("change", this.handleTableSizeSelect);
    this.tableSizeField = undefined;
    this.tableCompactSwitch?.removeEventListener("change", this.handleSetCompactToggle);
    this.tableCompactSwitch = undefined;
    // Empty controls
    while (this.tableControls?.firstChild) this.tableControls.firstChild.remove();
    this.tableControls?.remove();
  }
  private enableResizer() {
    this.tableResizer?.reset({ disable: false });
  }
  destroy() {
    this.removeControls();
    this.tableResizer?.reset({ disable: true });
    this.tableResizer = undefined;
    this.dataTable?.off("column-sizing", () => this.enableResizer());
    this.dataTable?.destroy(true);
    this.dataTable = undefined;
    removeClass(this.yasr.rootEl, "isSinglePage");
  }
}
