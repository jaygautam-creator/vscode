export interface UpdateCheckResult {
    available: boolean;
    version: string;
    downloadUrl: string;
}

interface GitHubReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name: string;
    assets?: GitHubReleaseAsset[];
}

export class UpdateChecker {
    private readonly updateUrl = 'https://api.github.com/repos/jaygautam-creator/YuvaDev/releases/latest';

    async checkForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
        try {
            const resp = await fetch(this.updateUrl, {
                headers: { Accept: 'application/vnd.github.v3+json' },
            });
            if (!resp.ok) {
                return null;
            }

            const release = (await resp.json()) as GitHubRelease;
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            if (!latestVersion) {
                return null;
            }

            if (latestVersion !== currentVersion) {
                const assets = release.assets ?? [];
                const asset = assets.find((a) =>
                    process.platform === 'darwin'
                        ? a.name.endsWith('.dmg')
                        : process.platform === 'win32'
                            ? a.name.endsWith('.exe')
                            : a.name.endsWith('.AppImage')
                );

                return {
                    available: true,
                    version: latestVersion,
                    downloadUrl: asset?.browser_download_url ?? '',
                };
            }

            return { available: false, version: latestVersion, downloadUrl: '' };
        } catch {
            return null;
        }
    }
}
