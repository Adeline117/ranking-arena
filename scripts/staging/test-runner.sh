#!/bin/bash

###############################################################################
# Staging Environment Test Runner
#
# This script automates testing of all new features in staging environment
# Usage: ./scripts/staging/test-runner.sh
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STAGING_URL="${STAGING_URL:-https://your-staging-url.vercel.app}"
CRON_SECRET="${CRON_SECRET:-}"
ACCESS_TOKEN="${ACCESS_TOKEN:-}"

# Test results
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

###############################################################################
# Helper Functions
###############################################################################

print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_test() {
    echo -e "${YELLOW}▶ Testing: $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
    ((TESTS_PASSED++))
}

print_failure() {
    echo -e "${RED}✗ $1${NC}"
    ((TESTS_FAILED++))
}

print_skip() {
    echo -e "${YELLOW}⊘ $1${NC}"
    ((TESTS_SKIPPED++))
}

check_prerequisites() {
    print_header "Checking Prerequisites"

    # Check if curl is installed
    if command -v curl &> /dev/null; then
        print_success "curl is installed"
    else
        print_failure "curl is not installed"
        exit 1
    fi

    # Check if jq is installed
    if command -v jq &> /dev/null; then
        print_success "jq is installed"
    else
        print_skip "jq is not installed (optional, for JSON parsing)"
    fi

    # Check environment variables
    if [ -z "$STAGING_URL" ]; then
        print_failure "STAGING_URL is not set"
        echo "Please set STAGING_URL environment variable"
        exit 1
    else
        print_success "STAGING_URL is set: $STAGING_URL"
    fi

    if [ -z "$CRON_SECRET" ]; then
        print_skip "CRON_SECRET not set (will skip cron endpoint tests)"
    else
        print_success "CRON_SECRET is set"
    fi
}

test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local expected_status="$4"
    local auth_header="${5:-}"

    print_test "$name"

    local response
    if [ -n "$auth_header" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Authorization: Bearer $auth_header" \
            "${STAGING_URL}${endpoint}")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${STAGING_URL}${endpoint}")
    fi

    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "$expected_status" ]; then
        print_success "$name returned $http_code (expected $expected_status)"
        echo "  Response preview: $(echo "$body" | head -c 100)..."
        return 0
    else
        print_failure "$name returned $http_code (expected $expected_status)"
        echo "  Response: $body"
        return 1
    fi
}

###############################################################################
# Test Suites
###############################################################################

test_smart_scheduler() {
    print_header "Testing Smart Scheduler"

    if [ -z "$CRON_SECRET" ]; then
        print_skip "Skipping Smart Scheduler tests (CRON_SECRET not set)"
        return
    fi

    # Test tier calculation endpoint
    test_endpoint \
        "Tier Calculation API" \
        "GET" \
        "/api/cron/calculate-tiers" \
        "200" \
        "$CRON_SECRET"

    # Test scheduler stats endpoint
    test_endpoint \
        "Scheduler Stats API" \
        "GET" \
        "/api/admin/scheduler/stats" \
        "200"
}

test_anomaly_detection() {
    print_header "Testing Anomaly Detection"

    if [ -z "$CRON_SECRET" ]; then
        print_skip "Skipping Anomaly Detection tests (CRON_SECRET not set)"
        return
    fi

    # Test anomaly detection endpoint
    test_endpoint \
        "Anomaly Detection API" \
        "GET" \
        "/api/cron/detect-anomalies" \
        "200" \
        "$CRON_SECRET"

    # Test anomaly stats endpoint
    test_endpoint \
        "Anomaly Stats API" \
        "GET" \
        "/api/admin/anomalies/stats" \
        "200"
}

test_monitoring_dashboard() {
    print_header "Testing Monitoring Dashboard"

    # Test monitoring overview endpoint
    if [ -n "$ACCESS_TOKEN" ]; then
        test_endpoint \
            "Monitoring Overview API" \
            "GET" \
            "/api/admin/monitoring/overview" \
            "200" \
            "$ACCESS_TOKEN"
    else
        test_endpoint \
            "Monitoring Overview API (without auth)" \
            "GET" \
            "/api/admin/monitoring/overview" \
            "401"
    fi
}

test_search_enhancement() {
    print_header "Testing Search Enhancement"

    # Test advanced search - basic query
    test_endpoint \
        "Advanced Search - Basic Query" \
        "GET" \
        "/api/search/advanced?q=BTC&type=all&limit=5" \
        "200"

    # Test advanced search - with filters
    test_endpoint \
        "Advanced Search - With Filters" \
        "GET" \
        "/api/search/advanced?q=trader&type=traders&minRoi=10&sortBy=roi&limit=5" \
        "200"

    # Test recommendations - trending
    test_endpoint \
        "Recommendations - Trending" \
        "GET" \
        "/api/search/recommend?type=trending&limit=10" \
        "200"

    # Test advanced search - no query (should fail)
    test_endpoint \
        "Advanced Search - No Query (should fail)" \
        "GET" \
        "/api/search/advanced" \
        "400"
}

test_security() {
    print_header "Testing Security"

    # Test CRON endpoint without auth (should fail)
    test_endpoint \
        "CRON without Auth (should fail)" \
        "GET" \
        "/api/cron/calculate-tiers" \
        "401"

    # Test CRON endpoint with wrong auth (should fail)
    test_endpoint \
        "CRON with Wrong Auth (should fail)" \
        "GET" \
        "/api/cron/calculate-tiers" \
        "401" \
        "wrong-secret"

    # Test admin endpoint without auth (should fail)
    test_endpoint \
        "Admin without Auth (should fail)" \
        "GET" \
        "/api/admin/monitoring/overview" \
        "401"
}

test_existing_endpoints() {
    print_header "Testing Existing Endpoints (Regression)"

    # Test homepage
    test_endpoint \
        "Homepage" \
        "GET" \
        "/" \
        "200"

    # Test existing search suggestions
    test_endpoint \
        "Search Suggestions" \
        "GET" \
        "/api/search/suggestions?q=BTC&limit=5" \
        "200"

    # Test hot searches
    test_endpoint \
        "Hot Searches" \
        "GET" \
        "/api/search/hot" \
        "200"
}

###############################################################################
# Main Execution
###############################################################################

main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                               ║${NC}"
    echo -e "${BLUE}║         Ranking Arena - Staging Test Runner                  ║${NC}"
    echo -e "${BLUE}║                                                               ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Check prerequisites
    check_prerequisites

    # Run test suites
    test_existing_endpoints
    test_smart_scheduler
    test_anomaly_detection
    test_monitoring_dashboard
    test_search_enhancement
    test_security

    # Print summary
    print_header "Test Summary"
    echo -e "${GREEN}✓ Passed:  $TESTS_PASSED${NC}"
    echo -e "${RED}✗ Failed:  $TESTS_FAILED${NC}"
    echo -e "${YELLOW}⊘ Skipped: $TESTS_SKIPPED${NC}"
    echo ""

    local total=$((TESTS_PASSED + TESTS_FAILED))
    if [ $total -gt 0 ]; then
        local pass_rate=$((TESTS_PASSED * 100 / total))
        echo -e "Pass Rate: ${GREEN}${pass_rate}%${NC}"
    fi

    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${GREEN}  ✓ All tests passed! Staging environment is healthy.${NC}"
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        exit 0
    else
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${RED}  ✗ Some tests failed. Please review the output above.${NC}"
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        exit 1
    fi
}

# Run main function
main "$@"
