import { Range } from 'vscode-languageserver-textdocument';

import { aug } from './augmented';
import { delimitSubstring, splitCarefully } from '../util';

export type LuaNil = 'nil'
export type LuaNumber = 'number'
export type LuaBoolean = 'boolean'
export type LuaString = 'string'

export type LuaTable = {
	entries: { [key: string]: LuaType }
}

export type LuaFunction = {
	parameters: ({ name: string, type: LuaType })[],
	return: LuaType,
}

export type LuaType
	= LuaNil
	| LuaNumber
	| LuaBoolean
	| LuaString
	//| LuaVararg
	| LuaTable
	| LuaFunction
	| LuaType[]
	| { or: [LuaType, LuaType] }
	//| { and: [LuaType, LuaType] }
	//| { not: LuaType }

export type LuaVariable = {
	// every expression that were assigned to it, last in first
	values: aug.Expression[]
	// corresponding scopes
	scopes: LuaScope[]
}

export type LuaScope = {
	labels: Record<string, Range | undefined>,
	variables: Record<string, LuaVariable | undefined>,
	tag: string,
}

export function isLuaTable(type: LuaType): type is LuaTable {
	return !!(type as LuaTable).entries;
}

export function isLuaFunction(type: LuaType): type is LuaFunction {
	return !!(type as LuaFunction).return;
}

/**
 * ie. `toString()`
 * 
 * possible unexpected result: ```"unknown`"+type+"`type"```
 */
export function represent(type: LuaType): string {
	if ('string' === typeof type) return type;

	if (Array.isArray(type)) {
		const list = type
			.map(represent)
			.join(", ");
		return `[${list}]`;
	}

	if (isLuaFunction(type)) {
		const param = type.parameters
			.map(it => `${it.name}: ${it.type}`)
			.join(", ");
		const ret = represent(type.return);
		return `(${param}) -> ${ret}`;
	}

	if (isLuaTable(type)) {
		const entries = Object
			.entries(type.entries)
			.map(it => `${it[0]}: ${represent(it[1])}`)
			.join(", ");
		return `{ ${entries} }`;
	}

	if (type.or) {
		const [a, b] = type.or;
		const reprA = represent(a);
		const reprB = represent(b);
		return reprA + " | " + reprB;
	}

	// if (type.and) {
	// 	const [a, b] = type.and;
	// 	const reprA = !a.or ? represent(a) : `(${represent(a)})`;
	// 	const reprB = !b.or ? represent(b) : `(${represent(b)})`;
	// 	return reprA + " & " + reprB;
	// }

	// if (type.not) {
	// 	const c = type.not;
	// 	const reprC = !c.or && !c.and ? represent(c) : `(${represent(c)})`;
	// 	return "~" + reprC;
	// }

	return "unknown`"+type+"`type";
}

/**
 * ie. `fromString()`
 * 
 * possible unexpected result: ```'error`'+repr+'`type'```
 * 
 * @throws `SyntaxError`
 */
export function parse(repr: string): LuaType {
	repr = repr.trim();
	if ('nil' === repr || 'number' === repr || 'boolean' === repr || 'string' === repr )
		return repr;
	const character = repr.charAt(0);

	if ("(" === character && ")" === repr.charAt(repr.length-1)) {
		const [start, end] = delimitSubstring(repr, "(", ")");
		if (repr.length-1 === end)
			return parse(repr.substring(start, end));
	}

	if (repr.includes("|")) {
		const list = splitCarefully(repr, "|");
		if (1 < list.length)
			return list.map(parse).reduce((acc, cur) => acc ? { or: [acc, cur] } : cur, null!);
	}

	// if (repr.includes("&")) {
	// 	const list = splitCarefully(repr, "&");
	// 	if (1 < list.length)
	// 		return list.map(parse).reduce((acc, cur) => acc ? { and: [acc, cur] } : cur, null!);
	// }

	// if ("~" === character) {
	// 	return { not: parse(repr.substr(1)) };
	// }

	if ("{" === character && "}" === repr.charAt(repr.length-1)) {
		const inner = splitCarefully(repr.substr(1, repr.length-2), ",");
		return {
			entries: Object.fromEntries(inner
				.map(it => {
					const co = it.indexOf(":");
					const key = it.substring(0, co).trim();
					const type = parse(it.substring(co + 1));
					return [key, type];
				})
			),
		};
	}

	if ("[" === character && "]" === repr.charAt(repr.length-1)) {
		const inner = splitCarefully(repr.substr(1, repr.length-2), ",");
		return inner.map(parse);
	}

	if (repr.includes("->")) {
		const [paramStart, paramEnd] = delimitSubstring(repr, "(", ")");
		const [retStart, retEnd] = delimitSubstring(repr.substr(paramEnd), "[", "]");

		const params = splitCarefully(repr.substring(paramStart, paramEnd), ",");

		return {
			parameters: !params[0] ? [] : params
				.map(it => {
					const co = it.indexOf(":");
					const name = it.substring(0, co).trim();
					const type = parse(it.substring(co + 1));
					return { name, type };
				}),
			return: parse("[" + repr.substring(paramEnd+retStart, paramEnd+retEnd) + "]"),
		};
	}

	return 'error`'+repr+'`type' as LuaType;
}

/**
 * finds the right `LuaType` by inspecting an augmented `node`
 * (eg. through its `augValue` or `augValues`)
 */
export function resolve(node: aug.Node): LuaType {
	switch (node.type) {
		case 'Identifier': {
			if (node.augValue)
				return resolve(node.augValue);
			else return 'nil';
		}

		case 'NilLiteral': return 'nil';
		case 'NumericLiteral': return 'number';
		case 'StringLiteral': return 'string';
		case 'BooleanLiteral': return 'boolean';
		case 'VarargLiteral': return '...' as LuaType; // XXX: to account for

		case 'TableConstructorExpression': return { entries: {} };

		case 'FunctionDeclaration': {
			//const parameters = node.parameters.map(resolve);
			const parameters = node.parameters.map(it => (it as any).name ?? "...");
			// join each possible return as a union
			const ret = (node.augReturns ?? []).map(resolve).reduce((acc, cur) => acc ? { or: [acc, cur] } : cur, null!) ?? 'nil';
			return { parameters, return: ret };
		}
		case 'ReturnStatement': return node.arguments.map(resolve);

		case 'BinaryExpression': {
			switch (node.operator) {
				case '+':
				case '-':
				case '*':
				case '/':
				case '^':
				case '\\':
				case '&':
				case '|':
				case '^^':
					return 'number';
				case '==':
				case '<':
				case '>':
				case '<=':
				case '>=':
				case '!=':
				case '~=':
					return 'boolean';
			}
			break;
		}
		case 'UnaryExpression': {
			if ('not' === node.operator) return 'boolean';
			else return 'number';
		}
		case 'LogicalExpression': {
			const tya = resolve(node.left);
			const tyb = resolve(node.right);
			if ('and' === node.operator) {
				return 'nil' === tya ? 'nil'
					: 'boolean' === tya ? tyb + " | true" as LuaType
					: tyb;
			} else if ('or' === node.operator) {
				return 'nil' === tya ? tyb
					: 'boolean' === tya ? tyb + " | false" as LuaType
					: tya;
			}
			break;
		}
	}
	return "type`"+node.type as LuaType;
}
