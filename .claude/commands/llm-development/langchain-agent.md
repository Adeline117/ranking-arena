# LangChain/LangGraph Agent Development

Expert LangChain agent developer for production-grade AI systems using LangChain 0.1+ and LangGraph.

## Requirements

Build AI agent for: **$ARGUMENTS**

## Core Requirements

- Use latest LangChain 0.1+ and LangGraph APIs
- Implement async patterns throughout
- Include comprehensive error handling and fallbacks
- Integrate LangSmith for observability
- Design for scalability and production deployment
- Implement security best practices
- Optimize for cost efficiency

## Essential Architecture

### LangGraph State Management

```python
from langgraph.graph import StateGraph, MessagesState, START, END
from langchain_anthropic import ChatAnthropic

class AgentState(TypedDict):
    messages: Annotated[list, "conversation history"]
    context: Annotated[dict, "retrieved context"]
```

### Model Configuration
- **Primary LLM**: Claude Sonnet 4.5
- **Embeddings**: Voyage AI (voyage-3-large)

## Agent Types

### 1. ReAct Agents
Multi-step reasoning with tool usage using `create_react_agent(llm, tools, state_modifier)`

### 2. Plan-and-Execute
Complex tasks requiring upfront planning with separate planning and execution nodes

### 3. Multi-Agent Orchestration
Specialized agents with supervisor routing using `Command[Literal["agent1", "agent2", END]]`

## Memory Systems

- **Short-term**: `ConversationTokenBufferMemory`
- **Summarization**: `ConversationSummaryMemory`
- **Entity Tracking**: `ConversationEntityMemory`
- **Vector Memory**: `VectorStoreRetrieverMemory`

## RAG Pipeline

```python
from langchain_voyageai import VoyageAIEmbeddings
from langchain_pinecone import PineconeVectorStore

embeddings = VoyageAIEmbeddings(model="voyage-3-large")
vectorstore = PineconeVectorStore(index=index, embedding=embeddings)

retriever = vectorstore.as_retriever(
    search_type="hybrid",
    search_kwargs={"k": 20, "alpha": 0.5}
)
```

## Tools Integration

```python
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

class ToolInput(BaseModel):
    query: str = Field(description="Query to process")

async def tool_function(query: str) -> str:
    try:
        result = await external_call(query)
        return result
    except Exception as e:
        return f"Error: {str(e)}"

tool = StructuredTool.from_function(
    func=tool_function,
    name="tool_name",
    description="What this tool does",
    args_schema=ToolInput
)
```

## Production Deployment

### FastAPI with Streaming

```python
@app.post("/agent/invoke")
async def invoke_agent(request: AgentRequest):
    if request.stream:
        return StreamingResponse(
            stream_response(request),
            media_type="text/event-stream"
        )
    return await agent.ainvoke({"messages": [...]})
```

### Monitoring
- LangSmith for tracing
- Prometheus for metrics
- Structured logging with structlog

## Best Practices

1. Always use async: `ainvoke`, `astream`
2. Handle errors gracefully with fallbacks
3. Monitor everything
4. Optimize costs with caching
5. Secure secrets in environment variables
6. Test thoroughly with evaluation suites
7. Document extensively
8. Version control state with checkpointers
