/**
 * Better Harness Report for 云图计划 AVG 剧情播放器与编辑器项目
 * Generated: 2026-09-04T21:11:22Z
 */

import React from 'react';
import { Canvas, Card, Metric, Section, Alert } from '@qoder/canvas-components';

export const harnessReport = {
  project: '云图计划 AVG 剧情播放器与编辑器',
  target: 'yuntu-asset',
  provider: 'Qoder',
  analysisDate: '2026-09-04',
  mode: 'normal',
  
  summary: {
    score: 75,
    status: 'operational',
    track: 'Operationalize',
    findingsCount: 3,
    insights: [
      '基于浏览器 DOM/Canvas 的 AVG 播放引擎已实现核心功能',
      '建立了完整的工具链和回归测试体系',
      '资源管理和构建流程规范化'
    ]
  },

  keyMetrics: {
    avgScenesProcessed: 1878,
    moduleCount: 5,
    testPages: 19,
    toolsCount: 34,
    evidenceQuality: 'complete'
  },

  strengths: [
    {
      category: 'Architecture',
      points: [
        '纯静态网页架构确保跨平台兼容性',
        '分离的播放器、编辑器、构建工具各司其职',
        '回归测试体系完善，支持自动断言'
      ]
    },
    {
      category: 'Toolchain',
      points: [
        '字节码解码器支持 Cfg/Lang 格式分析',
        'Frida 运行时捕获提供深度调试能力',
        '资源索引自动生成优化加载性能'
      ]
    },
    {
      category: 'Code Quality',
      points: [
        '模块化设计，代码职责清晰',
        '自测页面覆盖核心功能域',
        '文档完整，包含 INTRO.md 和 MEMORY.md'
      ]
    }
  ],

  findings: [
    {
      id: 'F001',
      severity: 'Low',
      title: 'Session 证据缺失',
      description: '缺少生产环境 Session 使用数据，难以量化用户行为模式',
      recommendation: '考虑添加使用频率统计和用户反馈机制',
      impact: '中等',
      confidence: 'High',
      evidence: ['项目记忆中无 Session 数据收集'],
      actionItems: [
        '评估是否需要用户行为追踪',
        '定义关键使用指标',
        '制定数据采集方案'
      ]
    },
    {
      id: 'F002',
      severity: 'Low', 
      title: 'MCP 服务器发现不足',
      description: '仅检测到 3 个基础 MCP 服务器（browser-use, genui, schedule），未深入利用',
      recommendation: '探索 MCP 工具在剧本验证和资源转换中的应用潜力',
      impact: '低',
      confidence: 'Medium',
      evidence: ['mcps 目录存在 3 个服务器'],
      actionItems: [
        '评估 MCP 工具的适用场景',
        '开发自定义 MCP 工具链',
        '集成到工作流中'
      ]
    },
    {
      id: 'F003',
      severity: 'Low',
      title: '构建系统依赖外部命令',
      description: 'build-*.py 等脚本需要 Python 环境，test-* .mjs 需要 Node.js，环境配置可能复杂',
      recommendation: '考虑引入 Docker 容器化简化环境依赖',
      impact: '低',
      confidence: 'Medium',
      evidence: ['tools/目录存在 Python 和 JS 混合脚本'],
      actionItems: [
        '评估容器化收益',
        '编写 Dockerfile',
        '自动化环境设置'
      ]
    }
  ],

  recommendations: [
    {
      priority: 'Medium',
      category: 'User Insights',
      action: '建立用户行为分析机制',
      expectedBenefit: '更好地理解实际使用模式和优化方向'
    },
    {
      priority: 'Low',
      category: 'Infrastructure',
      action: '探索 MCP 工具增强自动化能力',
      expectedBenefit: '提升编辑器和诊断工具的智能化水平'
    },
    {
      priority: 'Low',
      category: 'Developer Experience',
      action: '改进环境配置复杂度',
      expectedBenefit: '降低新开发者入门门槛'
    }
  ],

  renderCanvas: () => {
    return (
      <Canvas title="Better Harness Analysis" date="2026-09-04">
        <Section title="项目概况">
          <Card>
            <Metric label="AVG 场景处理数" value={1878} unit="scenes" />
            <Metric label="模块数量" value={5} unit="modules" />
            <Metric label="回归测试页面" value={19} unit="pages" />
            <Metric label="工具集" value={34} unit="tools" />
          </Card>
        </Section>

        <Section title="核心优势">
          {strengths.map((item, i) => (
            <Card key={i} title={item.category}>
              {item.points.map((point, j) => (
                <div key={j}>✓ {point}</div>
              ))}
            </Card>
          ))}
        </Section>

        <Section title="关键发现">
          {findings.map((finding) => (
            <Alert 
              key={finding.id}
              severity={finding.severity}
              title={finding.title}
              description={finding.description}
            >
              <ul>
                {finding.actionItems.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </Alert>
          ))}
        </Section>

        <Section title="建议措施">
          {recommendations.map((rec, i) => (
            <Card key={i} title={`${rec.priority}: ${rec.category}`}>
              <p><strong>行动:</strong> {rec.action}</p>
              <p><strong>预期收益:</strong> {rec.expectedBenefit}</p>
            </Card>
          ))}
        </Section>
      </Canvas>
    );
  }
};

export default harnessReport;
