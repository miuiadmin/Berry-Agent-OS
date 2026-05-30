import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useThemeStore } from '@/lib/stores/theme-store';

const STORAGE_KEY = 'berry-api-keys';

export function SettingsPage() {
  const { theme, setTheme } = useThemeStore();
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const keys = JSON.parse(stored);
        setApiKey(keys.anthropic ?? '');
      } catch { /* ignore */ }
    }
  }, []);

  const handleSaveKey = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ anthropic: apiKey }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-2xl font-semibold">设置</h1>

      <Card>
        <CardHeader>
          <CardTitle>外观</CardTitle>
          <CardDescription>选择应用的主题模式</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Button
              variant={theme === 'light' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTheme('light')}
            >
              <Sun className="h-4 w-4 mr-1" />
              浅色
            </Button>
            <Button
              variant={theme === 'dark' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTheme('dark')}
            >
              <Moon className="h-4 w-4 mr-1" />
              深色
            </Button>
            <Button
              variant={theme === 'system' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTheme('system')}
            >
              <Monitor className="h-4 w-4 mr-1" />
              跟随系统
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API Key 管理</CardTitle>
          <CardDescription>配置 LLM 提供商的 API Key（本地存储，不上传服务器）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="anthropic-key">Anthropic API Key</Label>
            <div className="flex gap-2">
              <Input
                id="anthropic-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="flex-1"
              />
              <Button onClick={handleSaveKey} variant="outline">
                {saved ? '已保存 ✓' : '保存'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
          <CardDescription>BerryAgent 桌面版</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>版本：0.2.0</p>
            <p>引擎：Electron + React 19</p>
            <p>数据库：SQLite (本地)</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
