import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

interface MarkdownRendererProps {
  content: string;
}

/**
 * Renders markdown with GitHub Flavored Markdown + syntax highlighting.
 * Mirrors axiomcloud's DocumentPopoutModal rendering.
 */
/**
 * Renders markdown. When used standalone (e.g., document viewer without comments),
 * wraps in prose-vf. When used inside CommentableDocumentViewer, the parent
 * already provides prose-vf — pass inline={true} to skip the wrapper.
 */
export function MarkdownRenderer({ content, inline }: MarkdownRendererProps & { inline?: boolean }) {
  const rendered = (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ children, ...props }) => {
            const id = slugify(String(children));
            return <h1 id={id} {...props}>{children}</h1>;
          },
          h2: ({ children, ...props }) => {
            const id = slugify(String(children));
            return <h2 id={id} {...props}>{children}</h2>;
          },
          h3: ({ children, ...props }) => {
            const id = slugify(String(children));
            return <h3 id={id} {...props}>{children}</h3>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto"><table>{children}</table></div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
  );

  if (inline) { return rendered; }
  return <div className="prose-vf">{rendered}</div>;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}
