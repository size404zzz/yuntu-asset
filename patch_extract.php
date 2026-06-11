<?php
/**
 * 少前2资源补丁包解压脚本
 * - 自动识别并按版本顺序解压所有zip补丁包
 * - 同路径文件保留修改日期较新的
 * - 去除ab文件头部8字节空数据，确保以UnityFS开头
 */

ini_set('memory_limit', '2048M');

$baseDir = __DIR__;
$extractDir = $baseDir . '/output';

// 创建输出目录
if (!is_dir($extractDir)) {
    mkdir($extractDir, 0777, true);
}

// 扫描所有zip文件并解析版本号
$zipFiles = glob($baseDir . '/*.zip');
$patches = [];

foreach ($zipFiles as $zipPath) {
    $filename = basename($zipPath, '.zip');

    // 解析版本号格式: 3.0.0.0_part0 或 3.0.0.0_3.0.0.1_part0
    if (preg_match('/^(\d+\.\d+\.\d+\.\d+)(?:_(\d+\.\d+\.\d+\.\d+))?_part(\d+)$/', $filename, $matches)) {
        $fromVersion = $matches[1];
        $toVersion = isset($matches[2]) ? $matches[2] : $matches[1];
        $partNum = intval($matches[3]);

        $patches[] = [
            'path' => $zipPath,
            'filename' => $filename,
            'from' => $fromVersion,
            'to' => $toVersion,
            'part' => $partNum
        ];
    }
}

// 按版本号排序
usort($patches, function($a, $b) {
    // 先按from版本排序
    $cmp = versionCompare($a['from'], $b['from']);
    if ($cmp !== 0) return $cmp;

    // 同from版本，基础包优先（from==to的是基础包）
    $aBase = ($a['from'] === $a['to']) ? 0 : 1;
    $bBase = ($b['from'] === $b['to']) ? 0 : 1;
    if ($aBase !== $bBase) return $aBase - $bBase;

    // 再按to版本排序
    $cmp = versionCompare($a['to'], $b['to']);
    if ($cmp !== 0) return $cmp;

    // 最后按part排序
    return $a['part'] - $b['part'];
});

echo "=== 少前2资源补丁包解压工具 ===\n\n";
echo "找到 " . count($patches) . " 个补丁包\n";
echo "输出目录: {$extractDir}\n\n";

// 显示处理顺序
echo "处理顺序:\n";
foreach ($patches as $i => $p) {
    $type = ($p['from'] === $p['to']) ? '基础包' : '增量包';
    echo "  " . ($i+1) . ". {$p['filename']}.zip ({$p['from']} -> {$p['to']}, {$type})\n";
}
echo "\n";

$stats = [
    'extracted' => 0,
    'skipped' => 0,
    'cleaned' => 0,
    'errors' => 0
];

// 按顺序处理每个补丁包
foreach ($patches as $index => $patch) {
    echo "[" . ($index + 1) . "/" . count($patches) . "] 处理: {$patch['filename']}.zip\n";

    $result = processPatch($patch['path'], $extractDir);
    $stats['extracted'] += $result['extracted'];
    $stats['skipped'] += $result['skipped'];
    $stats['cleaned'] += $result['cleaned'];
    $stats['errors'] += $result['errors'];

    echo "  解压{$result['extracted']}, 跳过{$result['skipped']}, 清理ab{$result['cleaned']}, 错误{$result['errors']}\n";
}

echo "\n=== 完成 ===\n";
echo "总解压文件: {$stats['extracted']}\n";
echo "总跳过文件: {$stats['skipped']}\n";
echo "总清理ab文件: {$stats['cleaned']}\n";
echo "总错误: {$stats['errors']}\n";

/**
 * 处理单个补丁包
 */
function processPatch($zipPath, $destDir) {
    $stats = ['extracted' => 0, 'skipped' => 0, 'cleaned' => 0, 'errors' => 0];

    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        echo "  错误: 无法打开ZIP文件\n";
        $stats['errors']++;
        return $stats;
    }

    for ($i = 0; $i < $zip->numFiles; $i++) {
        $filename = $zip->getNameIndex($i);
        $stat = $zip->statIndex($i);

        // 跳过目录
        if (substr($filename, -1) === '/') {
            continue;
        }

        $destPath = $destDir . '/' . $filename;

        // 读取文件内容
        $content = $zip->getFromIndex($i);
        if ($content === false) {
            $stats['errors']++;
            continue;
        }

        // 处理ab文件：去除头部8字节空数据
        $isAbFile = strtolower(pathinfo($filename, PATHINFO_EXTENSION)) === 'ab';
        if ($isAbFile) {
            $unityfsPos = strpos($content, 'UnityFS');
            if ($unityfsPos === false) {
                $stats['errors']++;
                continue;
            }
            if ($unityfsPos > 0) {
                $content = substr($content, $unityfsPos);
                $stats['cleaned']++;
            }
        }

        // 保留旧文件：已存在则跳过
        if (file_exists($destPath)) {
            $stats['skipped']++;
            continue;
        }

        // 创建目录
        $destDirPath = dirname($destPath);
        if (!is_dir($destDirPath)) {
            mkdir($destDirPath, 0777, true);
        }

        // 写入文件
        if (file_put_contents($destPath, $content) !== false) {
            touch($destPath, $stat['mtime']);
            $stats['extracted']++;
        } else {
            $stats['errors']++;
        }
    }

    $zip->close();
    return $stats;
}

/**
 * 版本号比较
 */
function versionCompare($v1, $v2) {
    $parts1 = explode('.', $v1);
    $parts2 = explode('.', $v2);

    for ($i = 0; $i < 4; $i++) {
        $a = isset($parts1[$i]) ? intval($parts1[$i]) : 0;
        $b = isset($parts2[$i]) ? intval($parts2[$i]) : 0;
        if ($a !== $b) {
            return $a - $b;
        }
    }
    return 0;
}
