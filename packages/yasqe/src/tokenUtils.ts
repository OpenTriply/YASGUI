import { default as Yasqe, Token, Position } from "./";

/**
 * When typing a query, this query is sometimes syntactically invalid, causing
 * the current tokens to be incorrect This causes problem for autocompletion.
 * http://bla might result in two tokens: http:// and bla. We'll want to combine
 * these
 */

export function getCompleteToken(yasqe: Yasqe, token: Token, cur: Position): Token {
  if (!cur) {
    cur = yasqe.getDoc().getCursor();
  }
  if (!token) {
    token = yasqe.getTokenAt(cur);
  }

  return expandTokenToEnd(yasqe, expandTokenToStart(yasqe, token, cur), cur);
}
function expandTokenToStart(yasqe: Yasqe, token: Token, cur: Position): Token {
  var prevToken = yasqe.getTokenAt({
    line: cur.line,
    ch: token.start
  });
  // not start of line, and not whitespace
  if (prevToken.type != null && prevToken.type != "ws" && token.type != null && token.type != "ws") {
    token.start = prevToken.start;
    token.string = prevToken.string + token.string;
    return expandTokenToStart(yasqe, token, {
      line: cur.line,
      ch: prevToken.start
    }); // recursively, might have multiple tokens which it should include
  } else if (token.type != null && token.type == "ws") {
    //always keep 1 char of whitespace between tokens. Otherwise, autocompletions might end up next to the previous node, without whitespace between them
    token.start = token.start + 1;
    token.string = token.string.substring(1);
    return token;
  } else {
    return token;
  }
}
function expandTokenToEnd(yasqe: Yasqe, token: Token, cur: Position): Token {
  var nextToken = yasqe.getTokenAt({
    line: cur.line,
    ch: token.end + 1
  });
  // not end of line, and not whitespace
  if (
    nextToken.type != null &&
    nextToken.type != "ws" &&
    token.type != null &&
    token.type != "ws" &&
    // Avoid infinite loops as CM will give back the last token of in a line when requesting something larger then the lines length
    nextToken.end !== token.end
  ) {
    token.end = nextToken.end;
    token.string = token.string + nextToken.string;
    return expandTokenToEnd(yasqe, token, {
      line: cur.line,
      ch: nextToken.end
    }); // recursively, might have multiple tokens which it should include
  } else if (token.type != null && token.type == "ws") {
    //always keep 1 char of whitespace between tokens. Otherwise, autocompletions might end up next to the previous node, without whitespace between them
    token.end = token.end + 1;
    token.string = token.string.substring(token.string.length - 1);
    return token;
  } else {
    return token;
  }
}
export function getPreviousNonWsToken(yasqe: Yasqe, line: number, token: Token): Token {
  var previousToken = yasqe.getTokenAt({
    line: line,
    ch: token.start
  });
  if (previousToken != null && previousToken.type == "ws") {
    previousToken = getPreviousNonWsToken(yasqe, line, previousToken);
  }
  return previousToken;
}
export function getNextNonWsToken(yasqe: Yasqe, lineNumber: number, charNumber: number): Token {
  if (charNumber == undefined) charNumber = 1;
  var token = yasqe.getTokenAt({
    line: lineNumber,
    ch: charNumber
  });
  if (token == null || token == undefined || token.end < charNumber) {
    return null;
  }
  if (token.type == "ws") {
    return getNextNonWsToken(yasqe, lineNumber, token.end + 1);
  }
  return token;
}
