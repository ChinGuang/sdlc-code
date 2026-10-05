// SPDX-License-Identifier: MPL-2.0
// An ESLint rule (T26b): every source file of this repository starts with the
// SPDX line for its licence, below a shebang if it has one. `eslint --fix` adds
// the line to a file that lacks it, so a new file costs nothing to bring in line.

export const SPDX_HEADER = "// SPDX-License-Identifier: MPL-2.0";

/** The first line of the file's text that is not a shebang. */
function firstLine(text) {
  const lines = text.split(/\r?\n/);
  return lines[0]?.startsWith("#!") ? lines[1] : lines[0];
}

const rule = {
  meta: {
    type: "problem",
    fixable: "code",
    schema: [],
    messages: {
      missing: `T26b: a source file starts with \`${SPDX_HEADER}\` (run eslint --fix to add it).`,
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.text;
        if (firstLine(text)?.trim() === SPDX_HEADER) return;
        context.report({
          loc: { line: 1, column: 0 },
          messageId: "missing",
          fix(fixer) {
            const eol = text.includes("\r\n") ? "\r\n" : "\n";
            if (!text.startsWith("#!"))
              return fixer.insertTextBeforeRange(
                [0, 0],
                `${SPDX_HEADER}${eol}`,
              );
            // After the shebang's own line; a file that is only a shebang gets
            // the header on a new line.
            const end = text.indexOf("\n");
            return end === -1
              ? fixer.insertTextAfterRange(
                  [0, text.length],
                  `${eol}${SPDX_HEADER}${eol}`,
                )
              : fixer.insertTextAfterRange(
                  [0, end + 1],
                  `${SPDX_HEADER}${eol}`,
                );
          },
        });
      },
    };
  },
};

export default { rules: { header: rule } };
