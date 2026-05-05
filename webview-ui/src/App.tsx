import { useState, useEffect } from 'react';
import { ActivityFeed } from './components/ActivityFeed';
import { SettingsView } from './components/settings/SettingsView';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { CommentableDocumentViewer } from './components/comments/CommentableDocumentViewer';
import { DashboardView } from './components/DashboardView';
import { KanbanView } from './components/KanbanView';
import { WorkItemView } from './components/WorkItemView';

type View = 'activity' | 'settings' | 'document' | 'dashboard' | 'kanban' | 'workitem';

interface DocumentContext {
  content: string;
  title: string;
  entityType: 'document' | 'context';
  entityId: number;
  projectId: number;
  currentUserId?: number;
}

export function App() {
  const [view, setView] = useState<View>('activity');
  const [doc, setDoc] = useState<DocumentContext | null>(null);

  useEffect(() => {
    // Check initial mode set by extension before webview loads (via data attribute)
    const initialMode = document.body.dataset.vfMode;
    if (initialMode === 'settings') {
      setView('settings');
    } else if (initialMode === 'dashboard') {
      setView('dashboard');
    } else if (initialMode === 'kanban') {
      setView('kanban');
    } else if (initialMode === 'workitem') {
      setView('workitem');
    } else if (initialMode === 'document') {
      setView('document');
      const initialContent = document.body.dataset.vfContent;
      const title = document.body.dataset.vfTitle ?? 'Document';
      const entityType = (document.body.dataset.vfEntityType ?? 'document') as 'document' | 'context';
      const entityId = parseInt(document.body.dataset.vfEntityId ?? '0', 10);
      const projectId = parseInt(document.body.dataset.vfProjectId ?? '0', 10);
      const currentUserId = document.body.dataset.vfUserId
        ? parseInt(document.body.dataset.vfUserId, 10)
        : undefined;
      if (initialContent) {
        setDoc({ content: initialContent, title, entityType, entityId, projectId, currentUserId });
      }
    }

    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === 'showSettings') { setView('settings'); }
      else if (msg?.type === 'showActivity') { setView('activity'); }
      else if (msg?.type === 'closeSettings') { setView('activity'); }
      else if (msg?.type === 'showDocument' && typeof msg.content === 'string') {
        setView('document');
        setDoc({
          content: msg.content,
          title: msg.title ?? 'Document',
          entityType: msg.entityType ?? 'document',
          entityId: msg.entityId ?? 0,
          projectId: msg.projectId ?? 0,
          currentUserId: msg.currentUserId,
        });
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (view === 'settings') { return <SettingsView />; }
  if (view === 'dashboard') { return <DashboardView />; }
  if (view === 'kanban') { return <KanbanView />; }
  if (view === 'workitem') { return <WorkItemView />; }
  if (view === 'document' && doc) {
    // Use CommentableDocumentViewer when we have project/entity context
    if (doc.entityId && doc.projectId) {
      return (
        <CommentableDocumentViewer
          content={doc.content}
          documentTitle={doc.title}
          entityType={doc.entityType}
          entityId={doc.entityId}
          projectId={doc.projectId}
          currentUserId={doc.currentUserId}
        />
      );
    }
    // Fallback to plain rendering when context is missing
    return <MarkdownRenderer content={doc.content} />;
  }
  return <ActivityFeed />;
}
