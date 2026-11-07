import { redirect } from 'next/navigation';

const EditProjectPage = async ({ params }: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await params;
  redirect(`/projects/${encodeURIComponent(projectId)}/settings`);
};

export default EditProjectPage;
