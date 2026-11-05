import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { AddProjectForm } from '@/components/projects/add-project-form';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Add project · AI Agent Manager' };

const NewProjectPage = () => (
  <>
    <section aria-labelledby="page-title" className="space-y-3">
      <Button asChild variant="ghost" size="sm" className="-ml-2.5">
        <Link href="/projects">
          <ArrowLeft aria-hidden="true" />
          All projects
        </Link>
      </Button>
      <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
        Add project
      </h1>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
        Connect an existing local Git repository. AI Agent Manager checks the repository first and
        shows what it found before anything is saved.
      </p>
    </section>
    <div className="max-w-3xl">
      <AddProjectForm />
    </div>
  </>
);

export default NewProjectPage;
