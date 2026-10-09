import type { Element, ElementContent, Root } from "hast";

// rehype-katex replaces a fenced $$ block with a bare <span
// class="katex-display"> sitting directly between paragraphs. Wrapping each
// one in a <div class="dive-equation"> gives it a block to style. A
// paragraph that's just one inline equation (the model wrote a standalone
// equation as $...$ rather than $$...$$) gets the same centered look via
// dive-equation-line.
export function rehypeEquationBlocks() {
  const hasClass = (node: ElementContent, name: string): boolean =>
    node.type === "element" &&
    Array.isArray(node.properties.className) &&
    node.properties.className.includes(name);
  const visit = (parent: Root | Element) => {
    parent.children = parent.children.map((child) => {
      if (child.type !== "element") return child;
      if (hasClass(child, "katex-display")) {
        return { type: "element", tagName: "div", properties: { className: ["dive-equation"] }, children: [child] };
      }
      if (child.tagName === "p") {
        const content = child.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
        if (content.length === 1 && hasClass(content[0], "katex")) {
          child.properties.className = ["dive-equation-line"];
        }
      }
      visit(child);
      return child;
    }) as typeof parent.children;
  };
  return (tree: Root) => visit(tree);
}
