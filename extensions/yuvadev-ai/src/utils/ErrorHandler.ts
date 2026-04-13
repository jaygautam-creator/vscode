export interface HumanizedError {
    title: string;
    message: string;
    action: string;
    command?: string;
}

export function humanizeError(error: unknown): HumanizedError {
    const maybe = error as { status?: number } | undefined;

    if (typeof Response !== 'undefined' && error instanceof Response || typeof maybe?.status === 'number') {
        const status = typeof maybe?.status === 'number' ? maybe.status : (error as Response).status;
        const map: Record<number, HumanizedError> = {
            401: {
                title: 'Not authorized',
                message: 'IPC token invalid.',
                action: 'Restart YuvaDev',
                command: 'yuvadev.restart',
            },
            400: {
                title: 'Invalid request',
                message: 'Check your workspace folder is open.',
                action: 'Open a folder',
                command: 'workbench.action.files.openFolder',
            },
            429: {
                title: 'Rate limit reached',
                message: 'Too many requests. Please wait.',
                action: 'Open Settings',
                command: 'yuvadev.openSettings',
            },
            503: {
                title: 'Provider unavailable',
                message: 'AI provider is temporarily down.',
                action: 'Switch provider',
                command: 'yuvadev.openSettings',
            },
        };

        return map[status] ?? {
            title: 'Backend error',
            message: `Error ${status}`,
            action: 'Check output panel',
            command: 'workbench.action.output.toggleOutput',
        };
    }

    const text = String(error ?? 'Unknown error');
    if (text.includes('fetch') || text.includes('ECONNREFUSED')) {
        return {
            title: 'Backend offline',
            message: 'Cannot connect to YuvaDev backend.',
            action: 'Restart backend',
            command: 'yuvadev.restart',
        };
    }

    return {
        title: 'Unknown error',
        message: text,
        action: 'Check output panel',
        command: 'workbench.action.output.toggleOutput',
    };
}
