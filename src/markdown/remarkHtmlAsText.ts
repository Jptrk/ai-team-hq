/**
 * Raw HTML in agent-written markdown shows up as literal text instead of rendering
 * or silently vanishing. Pairs with never enabling rehype-raw.
 */
interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

export function remarkHtmlAsText() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'html') child.type = 'text';
        walk(child);
      }
    };
    walk(tree);
  };
}
