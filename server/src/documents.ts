import { parse, Options as ParseOptions, SyntaxError as ParseError } from 'pico8parse';
import { Connection, DocumentSymbolParams, Hover, HoverParams, TextDocuments, TextDocumentChangeEvent } from 'vscode-languageserver';
import { Range } from 'vscode-languageserver-textdocument';
import { SelfExplore } from './document/explore';
import { represent } from './document/typing';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SettingsManager } from './settings';

const parseOptions: Partial<ParseOptions> = {
	luaVersion: 'PICO-8-0.2.1',
	locations: true,
};

export class Document extends SelfExplore {

	constructor(public uri: string, private manager: DocumentsManager) {
		super();
	}

	onContentUpdate(textDocument: TextDocument) {
		try {
			console.log("Parsing document");
			this.clear();
			this.ast = parse(textDocument.getText(), parseOptions);
			this.updateSymbols();
		} catch (err) {
			if (err instanceof ParseError) {
				const line = err.line-1;
				const character = err.column;
				this.diagnostics.push({
					message: `${err.name}: ${err.message}`,
					range: {
						start: { line, character },
						end: { line, character },
					},
				});
			} else throw err;
		}
		return this.diagnostics;
	}

	onHover(range: Range): Hover | null {
		const index = `:${range.start.line}:${range.start.character}`;
		const found = this.ranges[index];
		// console.log("================" + index);
		// console.log(found);
		if (!found) return null;
		return {
			contents: {
				kind: 'markdown',
				value: [
					`(${found.scope}) ${found.name}: ${represent(found.type)}`,
					"```json",
					JSON.stringify(found.info, (k, v) => 'augValue' != k ? v : '[Circular]', 2),
					"```",
				].join("\r\n"),
			}
		};
	}

	onDocumentSymbol() {
		//console.log("Serving symbols");
		return this.symbols;
	}

	private updateSymbols() {
		//console.log("Updating symbols");
		//this.symbols = [];
		//explore[this.ast.type]?.(this.symbols, this.ast);

		//console.log("Building scope");
		// const settings = this.manager.settings.get(this.uri);
		// console.log("Pre-defined globals:");
		// console.log(settings?.parse.preDefinedGlobals);
		this.explore();
		//console.dir(this.globalScope, { depth: 42 });

		//console.log("Found ranges");
		//console.dir(this.ranges, { depth: 42 });
	}

}

export class DocumentsManager extends TextDocuments<TextDocument> {

	private cache: Map<string, Document>;
	private connection?: Connection;

	constructor(public settings: SettingsManager) {
		super(TextDocument);
		this.cache = new Map();
	}

	listen(connection: Connection) {
		super.listen(connection);
		this.connection = connection;

		this.onDidChangeContent(this.handleOnDidChangeContent.bind(this));
		connection.onHover(this.handleOnHover.bind(this));
		connection.onDocumentSymbol(this.handleOnDocumentSymbol.bind(this));
	}

	private handleOnDidChangeContent(change: TextDocumentChangeEvent<TextDocument>) {
		const uri = change.document.uri;
		const document = this.cache.get(uri) ?? new Document(uri, this);
		const diagnostics = document.onContentUpdate(change.document);

		this.cache.set(uri, document);
		this.connection?.sendDiagnostics({ diagnostics, uri });
	}

	private handleOnHover(textDocumentPosition: HoverParams) {
		const position = textDocumentPosition.position;
		const uri = textDocumentPosition.textDocument.uri;
		console.log("Hovering: " + JSON.stringify(position));

		const document = this.cache.get(uri);
		if (!document) return null;

		// range of the hovered line
		const range = {
			start: { ...position },
			end: { ...position },
		};
		range.end.character = range.start.character = 0;
		range.end.line = range.start.line + 1;

		// extract the line from the document
		const line = this.get(uri)?.getText(range);
		if (!line) return null;

		// extract the word from the line
		let start = position.character;
		let end = start;
		while (-1 < start && !" ()[],;.:<=>+-*/^\\~!&|'\"@%$#\n\t\r".includes(line[start])) start--;
		while (end < line.length && !" ()[],;.:<=>+-*/^\\~!&|'\"@%$#\n\t\r".includes(line[end])) end++;

		// range of the hovered word
		range.start.character = start+1;
		range.end.character = end;

		return document.onHover(range);
	}

	private handleOnDocumentSymbol(textDocumentIdentifier: DocumentSymbolParams) {
		const document = this.cache.get(textDocumentIdentifier.textDocument.uri);
		return document?.onDocumentSymbol();
	}

}
