const { Breakpoint } = require("vscode");

const specs = {
  C: require(`./specs/C`),
  F: require(`./specs/F`),
  D: require(`./specs/D`),
  H: require(`./specs/H`),
  P: require(`./specs/P`),
};

class Message {
  constructor(line, text) {
    this.line = line;
    this.text = text;
  }
}

module.exports = class RpgleFree {
  constructor(lines = [], indent = 2) {
    this.lastSpecType = ``;
    this.currentLine = -1;
    this.lines = lines;
    this.indent = indent;
    this.maxFixedFormatLineLength = 80;
    this.vars = {
      "*DATE": {
        name: `*DATE`,
        type: `D`,
        len: 10,
      },
    };

    this.messages = [];
    this.wasVarDtaAra = false;

    // Re-initialize the "module" (cached) variables used by
    //  each of the spec parser.
    for (const spec in specs) {
      specs[spec].init();
    }
  }

  addVar(obj) {
    if (obj.standalone === true) {
      this.vars[obj.name.toUpperCase()] = obj;
    }
  }

  suggestMove(obj) {
    let result = {
      change: false,
      value: ``,
    };

    let sourceVar = this.vars[obj.source.toUpperCase()];
    let targetVar = this.vars[obj.target.toUpperCase()];

    if (sourceVar === undefined) {
      if (obj.source.startsWith(`'`)) {
        // This means it's a character
        sourceVar = {
          name: obj.source,
          type: `A`,
          len: obj.source.length - 2,
        };

        if (targetVar === undefined) {
          // Basically.. if we're assuming that if the targetvar
          // is undefined (probably in a file) but we are moving
          // character date into it, let's assume it's a char field
          this.messages.push(
            new Message(
              this.currentLine,
              `Assuming ${obj.target} is a 'Char' field for MOVE/MOVEL operation.`
            )
          );

          targetVar = {
            name: obj.target,
            type: `A`,
          };
        }
      } else if (obj.source.startsWith(`*`)) {
        // I think we can pretend keywords are numeric and it'll still work
        sourceVar = {
          name: obj.source,
          type: `S`,
        };
      } else {
        // Is numeric
        sourceVar = {
          name: obj.source,
          type: `S`,
          len: obj.source.length,
        };
      }
      sourceVar.const = true;
    } else {
      switch (sourceVar.type.toUpperCase()) {
        case `D`:
          sourceVar.len = 10;
          sourceVar.const = true;
          break;
        case `T`:
          sourceVar.len = 8;
          sourceVar.const = true;
          break;
        case `Z`:
          sourceVar.len = 26;
          sourceVar.const = true;
          break;
      }
    }

    if (targetVar === undefined && sourceVar !== undefined) {
      this.messages.push(
        new Message(
          this.currentLine,
          `Assuming ${obj.target} is a type '${sourceVar.type}' for MOVE/MOVEL operation.`
        )
      );
      //Here we are assuming the target type based on the source type :)
      targetVar = {
        name: obj.target,
        type: sourceVar.type,
      };
    }

    if (targetVar !== undefined) {
      let assignee = targetVar.name;

      switch (targetVar.type.toUpperCase()) {
        case `S`: // numeric (not specific to packed or zoned)
          result.value = `${assignee} = ${sourceVar.name}`;
          break;

        case `D`: // date
          if (sourceVar.name.toUpperCase() === `*DATE`) {
            result.value = `${targetVar.name} = ${sourceVar.name}`;
          } else {
            if (obj.attr === ``) {
              result.value = `${targetVar.name} = %Date(${sourceVar.name})`;
            } else {
              result.value = `${targetVar.name} = %Date(${sourceVar.name}: ${obj.attr})`;
            }
          }
          break;

        case `A`: // character
        case `C`: // ucs2
        {
          const isMoveLeft = obj.dir.toUpperCase() === `MOVEL`;
          if (obj.padded) {
            if (isMoveLeft) {
              assignee = targetVar.name;
            } else {
              assignee = `EvalR ${targetVar.name}`;
            }
          } else {
            if (isMoveLeft) {
              if (sourceVar.const) {
                assignee = `%Subst(${targetVar.name}: 1: ${sourceVar.len})`;
              } else {
                assignee = `%Subst(${targetVar.name}: 1: %Len(${sourceVar.name}))`;
              }
            } else {
              if (sourceVar.const) {
                assignee = `%Subst(${targetVar.name}: %Len(${targetVar.name}) - ${sourceVar.len})`;
              } else {
                assignee = `%Subst(${targetVar.name}: %Len(${targetVar.name}) - %Len(${sourceVar.name}))`;
              }
            }
          }

          switch (sourceVar.type.toUpperCase()) {
            case `A`:
            case `C`:
              result.value = `${assignee} = ${sourceVar.name}`;
              break;

            case `S`:
            case `P`:
            case `I`:
            case `F`:
            case `U`:
              result.value = `${assignee} = %Char(${sourceVar.name})`;
              break;

            case `D`:
            case `T`:
            case `Z`:
              if (obj.attr !== ``) {
                result.value = `${assignee} = %Char(${sourceVar.name}: ${obj.attr})`;
              } else {
                result.value = `${assignee} = %Char(${sourceVar.name})`;
              }
          }
          break;
        }
      }
    }

    if (result.value !== ``) {
      result.change = true;
      result.value = result.value + `;`;
    } else {
      this.messages.push(
        new Message(this.currentLine, `Unable to convert MOVE/MOVEL operation.`)
      );
    }
    return result;
  }

  parse() {
    let length,
      line,
      nextline,
      comment,
      isMove,
      hasKeywords,
      ignoredColumns,
      spec;

    let result = {};
    let spaces = 0;
    let wasSub = false;
    let wasLIKEDS = false;
    let fixedSql = false;
    let lastBlock = ``;
    let index = 0;
    let isCommentLine = false;
    let isDirectiveLine = false;
    let compileTimeTableLines = false;
    let convertToFullyFree = false;

    length = this.lines.length;
    if (0 < length) {
      convertToFullyFree = `**free` === this.lines[0].trim().toLowerCase();
    }
    for (index = 0; index < length; index++) {
      if (this.lines[index] === undefined) {
        continue;
      }

      this.currentLine = index;
      line = ` ` + this.lines[index].padEnd(this.maxFixedFormatLineLength);
      comment = ``;
      ignoredColumns = line.substring(1, 6) + `  `;
      isDirectiveLine = line[7] === `/`;
      isCommentLine = line[7] === `*` || 0 == line.trim().indexOf(`//`);

      // If this is not a comment line, then split the fixed format end line comment
      //  of into its own variable.  Note that we aded 1 space to the line, so we
      //  need to use the max length + 1.
      if (line.length > (this.maxFixedFormatLineLength + 1) && true !== isCommentLine) {
        comment = line.substring((this.maxFixedFormatLineLength + 1))
        line = line.substring(0, (this.maxFixedFormatLineLength + 1));
      }

      // If we are converting to **FREE, then ignore the mod markers (gutter) in positions 1-5.
      if (true === convertToFullyFree) {
        ignoredColumns = "".padEnd(ignoredColumns.length);
      }

      // If this is a comment line, then basically strip out the specification type.
      if (isCommentLine || isDirectiveLine) {
        line = line.replace(/^(.{6})(.)(\*|\/)/, "$1 $3");
      }
      spec = line[6].trim().toUpperCase();

      if (this.lines[index + 1]) {
        nextline = ` ` + this.lines[index + 1].padEnd(this.maxFixedFormatLineLength);
        if (nextline.length > (this.maxFixedFormatLineLength + 1)) {
          nextline = nextline.substring(0, (this.maxFixedFormatLineLength + 1));
        }
      } else {
        nextline = ``;
      }

      // If we have already marked the beginning of the compile-time
      //  table source records, we can stop parsing.  However, if this is
      //  the marker of the (first) compile time table, flush any cached
      //  lines from the last spec type before skipping conversion.
    if (compileTimeTableLines) {
      break;
    } else if (0 < index && line.startsWith(` **`)) {
      compileTimeTableLines = true;
      if (this.lastSpecType !== ``) {
        ignoredColumns = "".padEnd(ignoredColumns.length);
        result = specs[this.lastSpecType].final(this.indent, wasSub, wasLIKEDS);
        mergeArrayOutput.call(this, false);

        this.lastSpecType = ``;
      }
      break;
    }

      if (isCommentLine) {
        spec = ``;
        // For ILEDocs, the start comment block `/**` should
        //  be converted to `///`.  Likewise, the end comment
        //  block ` */` should be converted to '///'.  For these
        //  to be true ILEDocs start/end markers they must start
        //  in position 6.
        const ILEDocStartEndComment = line.substring(6).trimEnd();
        if (ILEDocStartEndComment === ` **`) {
          comment = `/`;
        } else if (ILEDocStartEndComment === ` */`) {
          comment = `/`;
        } else if (line[7] === `*`) {
          comment = line.substring(8).trimEnd();
        } else {
          comment = line.slice(line.indexOf(`//`) + 2).trimEnd();
        }
        // Previously, we would remove a blank comment line.
        // However, in order to get to this point, the line was not
        // blank, but was literally commented.  So, keep the "comment"
        // even if it is blank.
        this.lines[index] = `${"".padEnd(7)}${"".padEnd(spaces)}//${comment}`;
      } else {
        switch (line[7]) {
          case `/`:
          {
            let test = line.substring(8, 16).trim().toUpperCase();
            switch (test) {
              case `EXEC SQL`:
                // deal with embedded SQL just like normal c-specs
                fixedSql = true;
                spec = `C`;
                break;
              case `END-EXEC`:
                // deal with embedded SQL just like normal c-specs
                fixedSql = false;
                spec = `C`;
                break;
              case `FREE`:
              case `END-FREE`:
                spec = ``;
                this.lines.splice(index, 1);
                index--;
                // ?? length--;
                continue;
              default:
                spec = ``;
                this.lines[index] =
                  ``.padEnd(7) + ``.padEnd(spaces) + line.substring(7).trim();
                break;
            }
            break;
          }

          case `+`:
            // deal with embedded SQL just like normal c-specs
            if (fixedSql) {
              spec = `C`;
            }
            break;
        }
      }

      if (specs[spec] !== undefined) {
        // If we have switched the specification type,
        //  flush any cached info from the prior spec type.
        if (this.lastSpecType !== spec) {
          if (this.lastSpecType !== `` && spec) {
            result = specs[this.lastSpecType].final(this.indent, wasSub, wasLIKEDS);
            outputParsedResults.call(this);
          }

          this.lastSpecType = spec;
        }
        result = specs[spec].parse(line, this.indent, wasSub, wasLIKEDS);
        outputParsedResults.call(this);
      } else {
        // Assume comments and directives both apply to the
        //  preceeding block.
        if (wasSub && !isCommentLine && !isDirectiveLine) {
          endBlock(this.lines, this.indent);
        } else {
          // If the current line is not a comment nor a directive and is not empty,
          //  flush the prior spec type as we do not know what this type is.
          if (line.trim() !== `` && !isCommentLine && !isDirectiveLine && spec !== this.lastSpecType) {
            if (this.lastSpecType !== ``) {
              result = specs[this.lastSpecType].final(this.indent, wasSub, wasLIKEDS);
              mergeArrayOutput.call(this, false);
              this.lastSpecType = ``;
            }
          }
        }
      }
    }

    // catch any held info incase the last line was not a "spec"
    mergeArrayOutput.call(this, false);

    if (this.lastSpecType !== ``) {
      result = specs[this.lastSpecType].final(this.indent, wasSub, wasLIKEDS);
      this.currentLine = this.lines.length - 1;
      index = this.currentLine;
      length = this.currentLine;
      mergeArrayOutput.call(this, false);
  
      this.lastSpecType = ``;
    }

    function endBlock(lines, indent) {
      if (lastBlock !== undefined && lastBlock !== ``) {
        if (spaces > indent) {
          spaces -= indent;
        } else {
          spaces = 0;
        }
        lines.splice(index, 0, `${"".padEnd(7)}${"".padEnd(spaces)}End-${lastBlock};`
        );
        index++;
        length++;
      }
      wasSub = false;
    }

    /** Merges the parsed array output into the selected lines to be converted */
    function mergeArrayOutput(replaceCurrentLine = false) {
      if (result.arrayoutput.length > 0) {
        if (replaceCurrentLine) {
          this.lines.splice(index, 1);
        }
        for (let y in result.arrayoutput) {
          this.lines.splice(index, 0, `${ignoredColumns}${"".padEnd(spaces)}${result.arrayoutput[y]}`);
          index++;
          length++;
        }
        result.arrayoutput = [];
        if (replaceCurrentLine) {
          index--;
          // ?? length--;
        }
      }
    }

    /** Quotes name values */
    function quoteNameValues(line = ``, blockType = ``, wasVarDtaAra = true) {
      let quoteName = true;

      // This only applys to DS block types and other Dcl-* lines
      if (blockType !== `DS` && (blockType !== `` || !/Dcl-.*DTAARA *\(/i.test(line))) {
        return line;
      }

      // If we cannot find the DTAARA/EXTNAME/EXTFLD with a
      //  value to be enclosed in parens, then do nothing (more).
      let keywordParts = line.match(/^(.* (DTAARA|EXTNAME|EXTFLD) *?\((\*[^:]*: *)*)([^)]+)(\).*)$/i);
      if (!keywordParts || keywordParts.length !== 6) {
        return line;
      }

      // Turn off quoting if this is a DTAARA that used the
      //  *VAR modifier.
      if (/DTAARA *\([^\)]*\*VAR *:.*?\)/i.test(line)) {
        line = line.replace(/(DTAARA *\([^\)]*)\*VAR *:/i, '$1');
        quoteName = false;
        wasVarDtaAra = true;
      } else if (true === wasVarDtaAra) {
        quoteName = false;
      }

      //  If we added the DtaAra(*AUTO) and the definition had a DtaAra(),
      //  we now have two DtaAra keywords.  So, merge the two.
      if (/DTAARA\(\*AUTO\).*DTAARA/i.test(line)) {
        line = line.replace(/DTAARA\(\*AUTO\)/i, "".padEnd(13));
        line = line.replace(/DTAARA *\( */i, `DtaAra(*AUTO: `);
      }

      // If the value is already quoted, do nothing.
      keywordParts = line.match(/^(.* (DTAARA|EXTNAME|EXTFLD) *?\((\*[^:]*: *)*)([^)]+)(\).*)$/i);
      let extValue = keywordParts[4].trim();
      if (extValue.substring(0, 1) === `'`) {
        return line;
      }

      // The EXTNAME supports the extname(file-name {: fromat-name} {*ALL|*INPUT|*OUTPUT|*KEY|*NULL})
      // We can only quote the file-name; all other parts are to remain unquoted.
      // Likewise, the DTAARA keyword supports an optional usage parameter
      let extOptions = ``, extName = extValue;
      const extValueParts = extValue.split(/^([^:]+?)(:.*)$/);
      if (extValueParts.length >= 2) {
        extName = extValueParts[1].trim();
        // Force consistent spacing around the colon separator
        //  (that is no leading spaces, and 1 space after).
        extOptions = extValueParts[2].trim().replace(/ {0,}: {0,}\*/g, `: \*`).replace(/^:( *)(.*?)( *)(:.*)$/g, `: $2 $4`);
      }
      if (true === quoteName) {
        extName = `'${extName.toUpperCase()}'`;
      }
      wasVarDtaAra = false;
      return `${keywordParts[1]}${extName}${extOptions}${keywordParts[5]}`;
    }

    /** Fixes the varying keyword by removing it and prepending Var to data type */
    function fixVaryingKeyword(line = ``, blockType = ``) {
      // This only applys to DS, PR, and PI block types
      if ( !(/^(DS|PR|PI)$/.test(blockType)) && 0 != line.trimLeft().indexOf(`Dcl-S `)) {
        return line;
      }

      // The data type must be one of the supported varying
      //  data types.  Additionally, the VARYING keyword must
      //  be present.  If both conditions are not met, do nothing.
      if (!/\b(Char|Graph|Ucs2)\(.* VARYING( *\( *\d *\))?[ ;]/i.test(line)) {
        return line;
      }

      // To simplify the regex, we want to force a trailing semicolon.
      //  So, we will remove it if it exists, add one on to the end,
      //   and then when we are all done, put it back (if it was there
      //   to start with).
      let semicolon = ``;
      if (line.substr(-1) === `;`) {
        line = line.slice(0, -1);
        semicolon = `;`;
      }

      // The regex we are using is to break down the line into various
      //  parts that we can reassemble as we see fit.  This includes:
      //  $1  = All text before the data type
      //  $2  = The data type, '(', and length (no trailing ')').
      //  $5  = Spaces after the ending ')' of the data type
      //        Up to 3 leading spaces have been removed from
      //        $5 to account for the added "Var".  If the
      //        varying does not have a length specified, this
      //        will try and preserve the alignment of the keywords.
      //  $6  = Text after the spaces following the data type up to
      //        the VARYING keyword.
      //  $9  = The VARYING length, if specified or undefined
      //  $10 = Text after the VARYING keyword (and optional length)
      //        up to, but not including, the ending semicolon.
      const results = (line + `;`).match(
        /^(.*)( (Char|Graph|Ucs2)\(\d+)(\) {0,4})( *?)(.*)(VARYING( *\( *(\d) *\) *)?)(.*);$/i
      );
      if (results && results.length >= 10) {
        line = (
          results[1] +
          ` Var` +
          results[2].trim().toLowerCase() +
          (results[9] === undefined ? `` : `:` + results[9]) +
          `) ` +
          results[5] +
          results[6] +
          (results[10] === undefined ? `` : results[10].trim())
        ).trimRight();
      }
      return line + semicolon;
    }

    /**
     * Performs additional processing of keywords after they are combined onto one line
     *
     * Because keywords can be placed on multiple lines and even span multiple
     *  lines, it is necessary to perform some additional processing of keywords
     *  once we have merged the multiple lines into a single line.
     */
    function postProcessKeyWords(line = ``, blockType = ``, wasVarDtaara = false) {
      line = fixVaryingKeyword(line, blockType);
      line = quoteNameValues(line, blockType, wasVarDtaara);
      return line;
    }
    
    /** Outputs the parsed results */
    function outputParsedResults() {
      if (result.isSub !== undefined && result.isSub === true) {
        if (result.isHead === true && wasSub && !wasLIKEDS) {
          endBlock(this.lines, this.indent);
        }
        wasSub = true;
        lastBlock = result.blockType;
      } else if (result.isSub === undefined && wasSub) {
        endBlock(this.lines, this.indent);

        // Fixed format RPG does not allow nested DS.
        //  If the current block is DS and the previous was
        //  also a DS, then we need to force an end.
        //  This is required for DS defined with an EXTNAME
        //  as they may or may not have subfields.
      } else if (result.blockType === `DS` && wasSub) {
        endBlock(this.lines, this.indent);
      }

      wasLIKEDS = result.isLIKEDS === true;

      if (result.var !== undefined) {
        this.addVar(result.var);
      }

      isMove = result.move !== undefined;
      hasKeywords = result.aboveKeywords !== undefined;

      if (result.message) {
        this.messages.push(new Message(this.currentLine, result.message));
      }

      // If an increment replacement value has been returned, we need
      //  to look back through the code to see if we can find the
      //  named increment and replace it with the value returned.
      if (result.incrementReplacement !== undefined && null !== result.incrementReplacement.name) {
        const matchToken = new RegExp(`(For .*?)( by ${result.incrementReplacement.name})`);
        let replaced = false;
        for (let idx = this.currentLine - 1; idx >= 0; idx--) {
          if (this.lines[idx].match(matchToken)) {
            if ("" === result.incrementReplacement.value || "1" === result.incrementReplacement.value) {
              this.lines[idx] = this.lines[idx].replace(matchToken, `$1`);
            } else {
              this.lines[idx] = this.lines[idx].replace(matchToken, `$1 by ${result.incrementReplacement.value}`);
              // If the increment value is negative, we need to switch the "For ... _to_ " to "For ... _downto_ ".
              // **CAUTION**: If the increment value is a variable, we have no idea if the value is going to
              //  be positive or negative.  As such, the DO/ENDDO converstion to FOR/ENDFOR may not work.
              if (result.incrementReplacement.value.charAt(0) === `-`) {
                this.lines[idx] = this.lines[idx].replace(new RegExp(`(For .* by ${result.incrementReplacement.value})( to )`), `$1 downto `);
              }
            }
            replaced = true;
            break;
          }
          if (!replaced) {
            this.messages.push(new Message(this.currentLine, `Unabled to find matching FOR for END/ENDDO; increment "${result.incrementReplacement.name}" with value "${result.incrementReplacement.value}" not set.`));    
          }
        }
      }

      switch (true) {
        case result.ignore:
          break;

        case isMove:
          result = this.suggestMove(result.move);
          if (result.change) {
            this.lines[index] = `${ignoredColumns}${"".padEnd(spaces)}${result.value}`;
          }
          break;

        case hasKeywords:
        {
          let endStmti = this.lines[index - 1].indexOf(`;`);
          let endStmt = this.lines[index - 1].substring(endStmti); //Keep those end line comments :D
          let prevLineLastChar = this.lines[index - 1].substring(endStmti - 1, endStmti);
          switch (prevLineLastChar) {
            case `+`:
              this.lines[index - 1] =
                this.lines[index - 1].substring(0, endStmti - 1) +
                result.aboveKeywords.trim() +
                endStmt;
              break;
            case `-`:
              this.lines[index - 1] =
                this.lines[index - 1].substring(0, endStmti - 1) +
                result.aboveKeywords.trimRight() +
                endStmt;
              break;
            default:
              this.lines[index - 1] =
                this.lines[index - 1].substring(0, endStmti) +
                ` ` +
                result.aboveKeywords.trim() + endStmt;
              break;
          }
          this.lines.splice(index, 1);
          index--;
          // ?? length--;

          this.lines[index] = postProcessKeyWords(this.lines[index], result.blockType, this.wasVarDtaAra);
          break;
        }

        case result.remove:
          if (comment.trim() !== ``) {
            this.lines[index] =`${ignoredColumns}${"".padEnd(spaces)}//${comment}`;
          } else {
            this.lines.splice(index, 1);
            index--;
            length--;  // was originally ++ ?!?
          }
          break;

        case result.change:
          spaces += result.beforeSpaces;
          if (0 > spaces) {
            spaces = 0;
          }
          // no break, need to fall through to default logic
        default:
          if (result.arrayoutput.length > 0) {
            // Relace the current line with the array of output lines
            mergeArrayOutput.call(this, true);

          } else {
            this.lines[index] = `${ignoredColumns}${"".padEnd(spaces)}${result.value}`;
            this.lines[index] = postProcessKeyWords(this.lines[index], result.blockType, this.wasVarDtaAra);
            if (comment.trim() !== ``) {
              this.lines[index] += ` //${comment}`;
            }
          }

          spaces += result.nextSpaces;
          if (0 > spaces) {
            spaces = 0;
          }
          break;
      }
    }
  }
};
