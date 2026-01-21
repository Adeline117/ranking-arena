/**
 * Skills Registry
 *
 * This module provides a registry of all available AI agent skills.
 * Skills are specialized agents that can be invoked for specific tasks.
 *
 * Based on plugins from: https://github.com/wshobson/agents
 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  model?: 'opus' | 'sonnet' | 'haiku' | 'inherit';
  filePath: string;
  tags: string[];
}

export type SkillCategory =
  | 'code-review'
  | 'security'
  | 'database'
  | 'devops'
  | 'testing'
  | 'frontend'
  | 'backend'
  | 'data'
  | 'ml-ai'
  | 'blockchain'
  | 'observability'
  | 'architecture'
  | 'documentation';

export const skills: Skill[] = [
  // Code Review & Quality
  {
    id: 'ai-review',
    name: 'AI Code Review',
    description: 'AI-powered code review combining static analysis and intelligent pattern recognition',
    category: 'code-review',
    model: 'sonnet',
    filePath: 'code-review-ai/ai-review.md',
    tags: ['code-review', 'security', 'quality', 'ci-cd'],
  },

  // Quantitative Trading (High Priority for Crypto Platform)
  {
    id: 'quant-analyst',
    name: 'Quantitative Analyst',
    description: 'Build financial models, backtest trading strategies, and analyze market data',
    category: 'data',
    model: 'inherit',
    filePath: 'quantitative-trading/quant-analyst.md',
    tags: ['trading', 'finance', 'backtesting', 'quantitative'],
  },
  {
    id: 'risk-manager',
    name: 'Risk Manager',
    description: 'Monitor portfolio risk, R-multiples, position limits, and hedging strategies',
    category: 'data',
    model: 'inherit',
    filePath: 'quantitative-trading/risk-manager.md',
    tags: ['risk', 'trading', 'portfolio', 'hedging'],
  },

  // Blockchain & Web3
  {
    id: 'blockchain-developer',
    name: 'Blockchain Developer',
    description: 'Production-grade Web3 applications, smart contracts, and DeFi protocols',
    category: 'blockchain',
    model: 'inherit',
    filePath: 'blockchain-web3/blockchain-developer.md',
    tags: ['blockchain', 'web3', 'solidity', 'defi', 'smart-contracts'],
  },

  // Security
  {
    id: 'security-auditor',
    name: 'Security Auditor',
    description: 'DevSecOps, vulnerability assessment, threat modeling, and compliance',
    category: 'security',
    model: 'opus',
    filePath: 'security-scanning/security-auditor.md',
    tags: ['security', 'audit', 'compliance', 'devsecops'],
  },

  // Database
  {
    id: 'database-architect',
    name: 'Database Architect',
    description: 'Data layer design, schema modeling, and scalable database architectures',
    category: 'database',
    model: 'inherit',
    filePath: 'database-design/database-architect.md',
    tags: ['database', 'schema', 'postgresql', 'mongodb', 'architecture'],
  },

  // Performance & Observability
  {
    id: 'performance-engineer',
    name: 'Performance Engineer',
    description: 'Modern observability, application optimization, and scalable systems',
    category: 'observability',
    model: 'inherit',
    filePath: 'performance-testing-review/performance-engineer.md',
    tags: ['performance', 'optimization', 'profiling', 'load-testing'],
  },
  {
    id: 'observability-engineer',
    name: 'Observability Engineer',
    description: 'Production-grade monitoring, logging, tracing, and SLI/SLO management',
    category: 'observability',
    model: 'inherit',
    filePath: 'observability-monitoring/observability-engineer.md',
    tags: ['monitoring', 'logging', 'tracing', 'prometheus', 'grafana'],
  },

  // Languages & Frameworks
  {
    id: 'typescript-pro',
    name: 'TypeScript Pro',
    description: 'Advanced TypeScript with generics, strict type safety, and enterprise patterns',
    category: 'frontend',
    model: 'opus',
    filePath: 'javascript-typescript/typescript-pro.md',
    tags: ['typescript', 'javascript', 'react', 'nextjs'],
  },
  {
    id: 'python-pro',
    name: 'Python Pro',
    description: 'Modern Python 3.12+ with async, type hints, and production practices',
    category: 'backend',
    model: 'inherit',
    filePath: 'python-development/python-pro.md',
    tags: ['python', 'fastapi', 'django', 'async'],
  },

  // DevOps & CI/CD
  {
    id: 'devops-troubleshooter',
    name: 'DevOps Troubleshooter',
    description: 'Rapid incident response and advanced debugging in cloud-native environments',
    category: 'devops',
    model: 'sonnet',
    filePath: 'cicd-automation/devops-troubleshooter.md',
    tags: ['devops', 'kubernetes', 'debugging', 'incident-response'],
  },

  // AI & ML
  {
    id: 'ai-engineer',
    name: 'AI Engineer',
    description: 'Production-grade LLM applications, RAG systems, and agent orchestration',
    category: 'ml-ai',
    model: 'inherit',
    filePath: 'llm-application-dev/ai-engineer.md',
    tags: ['llm', 'rag', 'langchain', 'ai', 'agents'],
  },
  {
    id: 'ml-engineer',
    name: 'ML Engineer',
    description: 'Production-ready machine learning systems with PyTorch and MLOps',
    category: 'ml-ai',
    model: 'inherit',
    filePath: 'machine-learning-ops/ml-engineer.md',
    tags: ['ml', 'pytorch', 'tensorflow', 'mlops', 'model-serving'],
  },

  // Data Engineering
  {
    id: 'data-engineer',
    name: 'Data Engineer',
    description: 'Scalable data pipelines, modern data stack, and streaming architectures',
    category: 'data',
    model: 'inherit',
    filePath: 'data-engineering/data-engineer.md',
    tags: ['data', 'etl', 'spark', 'kafka', 'airflow', 'dbt'],
  },

  // Testing
  {
    id: 'test-automator',
    name: 'Test Automator',
    description: 'AI-powered test automation with modern frameworks and quality engineering',
    category: 'testing',
    model: 'sonnet',
    filePath: 'unit-testing/test-automator.md',
    tags: ['testing', 'playwright', 'automation', 'ci-cd', 'quality'],
  },
  {
    id: 'api-tester',
    name: 'API Tester',
    description: 'API testing, contract validation, and API observability',
    category: 'testing',
    model: 'inherit',
    filePath: 'api-testing-observability/api-tester.md',
    tags: ['api', 'testing', 'contract', 'performance', 'observability'],
  },

  // Architecture & Backend
  {
    id: 'backend-architect',
    name: 'Backend Architect',
    description: 'Scalable APIs, microservices, event-driven architectures, and resilience patterns',
    category: 'architecture',
    model: 'inherit',
    filePath: 'backend-api-security/backend-architect.md',
    tags: ['api', 'microservices', 'architecture', 'graphql', 'grpc'],
  },
  {
    id: 'kubernetes-architect',
    name: 'Kubernetes Architect',
    description: 'Cloud-native infrastructure, GitOps, service mesh, and platform engineering',
    category: 'devops',
    model: 'inherit',
    filePath: 'kubernetes-operations/kubernetes-architect.md',
    tags: ['kubernetes', 'gitops', 'argocd', 'helm', 'cloud-native'],
  },

  // Frontend
  {
    id: 'frontend-developer',
    name: 'Frontend Developer',
    description: 'Modern frontend with React, Next.js, TypeScript, and performance optimization',
    category: 'frontend',
    model: 'inherit',
    filePath: 'frontend-mobile-development/frontend-developer.md',
    tags: ['react', 'nextjs', 'frontend', 'typescript', 'accessibility'],
  },

  // Debugging
  {
    id: 'debugger',
    name: 'Debugger',
    description: 'Systematic debugging across web, backend, and distributed systems',
    category: 'devops',
    model: 'sonnet',
    filePath: 'debugging-toolkit/debugger.md',
    tags: ['debugging', 'troubleshooting', 'profiling', 'error-analysis'],
  },

  // Git & Workflow
  {
    id: 'git-workflow',
    name: 'Git Workflow',
    description: 'Git workflows, PR management, and collaborative development practices',
    category: 'devops',
    model: 'haiku',
    filePath: 'git-pr-workflows/git-workflow.md',
    tags: ['git', 'pr', 'workflow', 'code-review', 'branching'],
  },

  // Documentation
  {
    id: 'documentation-generator',
    name: 'Documentation Generator',
    description: 'Technical documentation, API docs, JSDoc, and OpenAPI specifications',
    category: 'documentation',
    model: 'haiku',
    filePath: 'code-documentation/documentation-generator.md',
    tags: ['documentation', 'api', 'jsdoc', 'openapi', 'technical-writing'],
  },
];

/**
 * Get all skills in a specific category
 */
export function getSkillsByCategory(category: SkillCategory): Skill[] {
  return skills.filter(skill => skill.category === category);
}

/**
 * Get a skill by its ID
 */
export function getSkillById(id: string): Skill | undefined {
  return skills.find(skill => skill.id === id);
}

/**
 * Search skills by tags
 */
export function searchSkillsByTags(tags: string[]): Skill[] {
  return skills.filter(skill =>
    tags.some(tag => skill.tags.includes(tag.toLowerCase()))
  );
}

/**
 * Get all unique tags across all skills
 */
export function getAllTags(): string[] {
  const tagSet = new Set<string>();
  skills.forEach(skill => skill.tags.forEach(tag => tagSet.add(tag)));
  return Array.from(tagSet).sort();
}

/**
 * Get skills relevant to cryptocurrency trading platform
 */
export function getCryptoTradingSkills(): Skill[] {
  const relevantTags = [
    'trading',
    'finance',
    'blockchain',
    'web3',
    'risk',
    'security',
    'data',
    'performance',
  ];
  return searchSkillsByTags(relevantTags);
}

export default skills;
