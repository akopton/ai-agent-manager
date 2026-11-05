'use client';

import { useEffect } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

const ProjectsError = ({ error, retry }: { error: unknown; retry: () => void }) => {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>Projects could not be loaded</AlertTitle>
      <AlertDescription>
        <p>An unexpected error occurred. Details are in the server log.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => retry()}>
          <RotateCcw aria-hidden="true" />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
};

export default ProjectsError;
