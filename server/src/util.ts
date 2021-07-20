import { ast } from 'pico8parse';
import { Position, Range, TextDocument } from 'vscode-languageserver-textdocument';

import { LuaDoc, LuaType, represent } from './document/typing';

/**
 * @used `document/ > explore.ts > SelfExplore{} > constructor > this.handlers`
 */
export function locToRange(loc: ast.Node['loc']): Range {
	const { start, end } = loc ?? { start: {line:1,column:0}, end: {line:1,column:0}, };
	return {
		start: {
			line: start.line-1,
			character: start.column,
		},
		end: {
			line: end.line-1,
			character: end.column,
		},
	};
}

/**
 * @used `documents.ts > Document{} > findScope()`
 */
export function rangeContains(range: Range, position: Position) {
	if (range.start.line < position.line && position.line < range.end.line)
		return true;
	if (range.start.line === position.line)
		if (range.start.character <= position.character)
			return true;
	if (range.end.line === position.line)
		if (position.character <= range.end.character)
			return true;
	return false;
}

/**
 * @used `documents.ts > DocumentsManager{} > handleOnHover()`
 */
export function findWordRange(document: TextDocument, position: Position): Range {
	// range of the hovered line
	const range = {
		start: { ...position },
		end: { ...position },
	};
	range.end.character = range.start.character = 0;
	range.end.line = range.start.line + 1;

	// extract the line from the document
	const line = document.getText(range);

	// extract the word from the line
	let start = position.character;
	let end = start;
	const wordSep = " \t\n\r()[]{}'\",;.:<=>~!+-*/^\\&|@%$#?";
	while (-1 < start && !wordSep.includes(line[start])) start--;
	while (end < line.length && !wordSep.includes(line[end])) end++;

	// range of the hovered word
	range.start.character = start+1;
	range.end.character = end;

	return range;
}

/**
 * find the first substring of `str` that is enclosed
 * by the delimiters `open` and `close` (eg. "[" and "]")
 * 
 * `open` and `close` must be different and 1 character
 * in length
 * 
 * the returned substring excludes the delimiters
 * (undefined if none where found)
 * 
 * fails if `close` is present before `open` in `str`
 * (ie. aborts and returns undefined)
 * 
 * @returns `[start, end]`
 * 
 * @throws `SyntaxError`
 * 
 * @example delimitSubstring("(a, b, c) -> [(d) -> nil]", "(", ")") === [1, 8]
 * 
 * @used `document/ > typing.ts > parse()`
 */
export function delimitSubstring(str: string, open: string, close: string) {
	let s = 0;
	let n = 0;
	for (let k = 0; k < str.length; k++) {
		const c = str[k];
		if (c === open) {
			if (0 === n) s = k+1;
			n++;
		} else if (c === close) {
			n--;
			if (0 === n) return [s, k] as [start: number, end: number];
			if (n < 0) break;
		}
	}
	throw new SyntaxError(n < 0
		? `No matching '${open}' for closing '${close}'`
		: `No matching '${close}' for opening '${open}'`
	);
}

/**
 * split `str` on `sep` in a list of substring while respecting
 * pairs of delimiters (eg. doesn't split on "," within "[]")
 * 
 * `sep` must be 1 character in length
 * 
 * the respected delimiters are the following pairs:
 * "()", "[]", "{}"
 * 
 * the returned substrings are trimmed
 * 
 * fails if `delimitSubstring` fails, returns undefined
 * 
 * @throws `SyntaxError`
 * 
 * @example splitCarefully("{ a: string, b: boolean }, number") === ["{ a: string, b: boolean }", " c: number"]
 * 
 * @used `document/ > typing.ts > parse()`
 */
export function splitCarefully(str: string, sep: string) {
	const r: string[] = [];
	let l = 0;
	const pairs = "()[]{}";
	for (let k = 0; k < str.length; k++) {
		const c = str[k];
		const f = pairs.indexOf(c);
		if (-1 < f) {
			if (f % 2) throw new SyntaxError(`No matching '${pairs[f-1]}' for closing '${pairs[f]}'`);
			k+= delimitSubstring(str.substr(k), pairs[f], pairs[f+1])[1];
		} else if (c === sep) {
			r.push(str.substring(l, k).trim());
			l = k+1;
		}
	}
	r.push(str.substr(l).trim());
	return r;
}

/**
 * XXX: if anyone can get it to display in both the right color and font...
 * 
 * @used `documents.ts > Document{} > handleOnHover()`
 */
export function representVariableHover(tag: string, name: string, type: LuaType, doc?: LuaDoc) {
	// const repr = represent(type).replace(
	// 	/(->)|\b([^,:]+)(?=:)|(nil|number|boolean|string)/g,
	// 	(substr, arrow, ident, type) => {
	// 		if (arrow) return `<span style="color:#569CD6;">${arrow}</span>`;
	// 		if (ident) return `<span style="color:#9CDCFE;">${ident}</span>`;
	// 		if (type) return `<span style="color:#4EC9B0;">${type}</span>`;
	// 		return substr;
	// 	}
	// );
	// const ident = `<span style="color:#9CDCFE;">${name}</span>`;
	// const info = `<span style="color:#C586C0;">${tag}</span>`;

	// return [
	// 	`(${info}) ${ident}: ${repr}`,
	// 	...(!doc ? [] : [
	// 		" ",
	// 		"---",
	// 		doc,
	// 	]),
	// ].join("\r\n");

	return [
		"```typescript", // will at least get _some_ of it right...
		`(${tag}) ${name}: ${represent(type)}`,
		"```",
		...(!doc ? [] : [
			" ",
			"---",
			doc.text,
		]),
	].join("\n");
}

// typing not perfect but will do
type BinaryTreeNode<K extends string, T> = Record<K, [left: BinaryTreeNode<K, T> | T, right: BinaryTreeNode<K, T> | T]>

/**
 * flattens a binary tree into a list
 * 
 * assumes that if `root` has a key named `propertyName`,
 * `root[propertyName]` is a tuple `[left, right]`
 * 
 * returns undefined otherwise
 * 
 * @used `document/ > typing.ts > simplify()`
 * @used `document/ > typing.ts > equivalent()`
 */
export function flattenBinaryTree<K extends string, T>(root: BinaryTreeNode<K, T> | T, propertyName: K): Exclude<T, BinaryTreeNode<K, T>>[] | undefined {
	if (Object.hasOwnProperty.call(root, propertyName)) {
		const yes = root as BinaryTreeNode<K, T>;
		if (Array.isArray(yes[propertyName]) && 2 === yes[propertyName].length) {
			const r: Exclude<T, BinaryTreeNode<K, T>>[] = [];

			const [a, b] = yes[propertyName];
			r.concat(flattenBinaryTree(a, propertyName) ?? []);
			r.concat(flattenBinaryTree(b, propertyName) ?? []);

			return r;
		}
	}
}

/**
 * in some situation, more than one Lua value can be emitted/accepted
 * (eg. vararg, return statement, table construct, function call)
 * 
 * undefine entries are counted as 'nil' types
 * 
 * the behavior is as follow:
 * ```plaintext
 * for each entry of the `types` list excluding the last one,
 *   if that entry is not an array, add it to the returned list
 *   else, add the first element of that array or nil if empty
 * 
 * if the last entry of `types` is an array,
 *   each element are added to the returned list
 * else, add the entry itself
 * ```
 * 
 * @used `document/ > explore.ts > SelfExplore{} > constructor > this.handlers > FunctionDeclaration`
 * @used `document/ > explore.ts > SelfExplore{} > constructor > this.handlers > TableConstructExpression`
 * @used `document/ > explore.ts > SelfExplore{} > constructor > this.handlers > LocalStatement`
 * @used `document/ > explore.ts > SelfExplore{} > constructor > this.handlers > AssignmentStatement`
 * @used `document/ > explore.ts > SelfExplore{} > constructor > this.handlers > AssignmentOperatorStatement`
 */
export function resolveListOfTypes(types: (LuaType | undefined)[]): LuaType[] {
	const r = types.slice(0, -1).map(it => {
		if (Array.isArray(it))
			return it[0] ?? 'nil';
		return it ?? 'nil';
	});
	if (0 !== types.length) {
		const last = types[types.length-1];
		if (Array.isArray(last))
			r.push(...last);
		else r.push(last ?? 'nil');
	}
	return r;
}
