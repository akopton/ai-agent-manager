import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { FolderGit2 } from 'lucide-react';
import { conversationContextModeLabels, conversationReferenceLimits } from '@ai-agent-manager/core';

import { ConversationPanel } from '@/components/conversations/conversation-panel';
import { ConversationChat } from '@/components/conversations/conversation-chat';
import { ConversationViews } from '@/components/conversations/conversation-views';
import { ConversationNotes } from '@/components/conversations/conversation-notes';
import { ConversationAutoRefresh } from '@/components/conversations/conversation-auto-refresh';
import { ConversationHistory } from '@/components/conversations/conversation-history';
import { ConversationAiNotice } from '@/components/conversations/conversation-notice';
import { ConversationSettingsForm } from '@/components/conversations/conversation-settings-form';
import { MessageComposer } from '@/components/conversations/message-composer';
import { TaskProposalsPanel } from '@/components/conversations/task-proposals-panel';
import { DatabaseNotReady } from '@/components/projects/database-not-ready';
import { describeLanguageMode } from '@/lib/conversations/format';
import { hasActiveGeneration } from '@/lib/conversations/proposals';
import { hasActiveTurn } from '@/lib/conversations/transcript';
import { describeModelChoice } from '@/lib/models/model-selection';
import { findConversationDetail } from '@/lib/server/conversations';
import { getDatabase } from '@/lib/server/database';
import { loadForPage } from '@/lib/server/load';
import { getProjectDetails } from '@/lib/server/projects';
import { agentRuntimeLabels } from '@/lib/tasks/board';

export const metadata: Metadata = { title: 'Conversation · AI Agent Manager' };

const ConversationPage = async ({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) => {
  await connection();
  const { projectId, conversationId } = await params;
  const result = await loadForPage(() =>
    findConversationDetail(getDatabase(), projectId, conversationId),
  );

  if (!result.ok) {
    return <DatabaseNotReady message={result.message} />;
  }
  if (result.data === undefined) {
    notFound();
  }

  const { project, conversation, messages, turns, ai, generations, proposals, sourceAccess } =
    result.data;
  const projectAware = conversation.contextMode === 'project_aware';
  const active = hasActiveTurn(turns);
  const generating = hasActiveGeneration(generations);
  const model = describeModelChoice(conversation.agentRuntime, conversation.modelId);
  // Branches for the proposal editor are read live (read-only), and only while drafts exist.
  const branches = proposals.some((proposal) => proposal.status === 'draft')
    ? await getProjectDetails(getDatabase(), project.id)
        .then((details) =>
          details?.repository.status === 'available' ? details.repository.branches : null,
        )
        .catch(() => null)
    : null;
  return (
    <>
      <ConversationAutoRefresh active={active || generating} />
      <ConversationViews
        key={conversation.id}
        referenceSources={messages.map(({ id, kind, role, content }) => ({
          sourceId: id,
          kind,
          role,
          preview: content.slice(0, conversationReferenceLimits.previewCharacters),
        }))}
        header={
          <div className="min-w-0 space-y-1">
            <h1
              id="page-title"
              className="line-clamp-2 text-xl font-semibold tracking-tight break-words sm:text-2xl"
              title={conversation.title}
            >
              {conversation.title}
            </h1>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                {agentRuntimeLabels[conversation.agentRuntime]} ·{' '}
                <span className="break-all">{model}</span>
              </span>
              <span
                className={
                  projectAware ? 'inline-flex items-center gap-1 font-medium text-info' : undefined
                }
              >
                {projectAware ? <FolderGit2 className="size-3.5" aria-hidden="true" /> : null}
                {conversationContextModeLabels[conversation.contextMode]}
              </span>
            </p>
          </div>
        }
        settings={
          <div className="max-w-2xl space-y-5">
            <p className="text-sm text-muted-foreground">
              Settings apply to your next message. Earlier replies keep the settings that produced
              them.
            </p>
            <ConversationSettingsForm
              key={conversation.id}
              projectId={project.id}
              conversation={conversation}
              sourceSharingAllowed={sourceAccess.current}
            />
            <p className="border-t pt-5 text-sm text-muted-foreground">
              Source-sharing permission is managed in{' '}
              <Link
                href={`/projects/${project.id}/settings#source-sharing`}
                className="text-primary underline underline-offset-4"
              >
                Project Settings
              </Link>
              .
            </p>
          </div>
        }
        notice={
          <ConversationAiNotice
            ai={ai}
            projectId={project.id}
            sourceBlocked={projectAware && !sourceAccess.current}
          />
        }
        turnActive={active}
        generating={generating}
        chat={
          <ConversationChat
            key={conversation.id}
            composer={{
              projectId: project.id,
              conversationId: conversation.id,
              aiEnabled: ai.enabled,
              turnActive: active,
              proposalsActive: generating,
              target: `${agentRuntimeLabels[conversation.agentRuntime]} · ${model} · ${describeLanguageMode(conversation.languageMode)} · ${conversationContextModeLabels[conversation.contextMode]}`,
            }}
          >
            <ConversationHistory
              projectId={project.id}
              conversationId={conversation.id}
              messages={messages}
              turns={turns}
              ai={ai}
              generations={generations}
            />
          </ConversationChat>
        }
        tasks={
          <ConversationPanel name="Tasks" label="Task proposals">
            <TaskProposalsPanel
              projectId={project.id}
              conversationId={conversation.id}
              defaultBaseBranch={project.defaultBaseBranch}
              branches={branches}
              generations={generations}
              proposals={proposals}
              aiEnabled={ai.enabled}
              turnActive={active}
            />
          </ConversationPanel>
        }
        notes={
          <ConversationPanel
            name="Notes"
            label="Saved conversation notes"
            footer={
              <MessageComposer
                key={`notes-${conversation.id}`}
                mode="note"
                projectId={project.id}
                conversationId={conversation.id}
                aiEnabled={ai.enabled}
                turnActive={active}
                proposalsActive={generating}
                target=""
              />
            }
          >
            <ConversationNotes
              projectId={project.id}
              messages={messages.filter((message) => message.kind === 'note')}
            />
          </ConversationPanel>
        }
      />
    </>
  );
};

export default ConversationPage;
