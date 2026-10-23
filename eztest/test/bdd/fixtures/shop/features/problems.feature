@negative
Feature: Problems are reported

  Scenario: An undefined step
    Given the shop is open
    When I do something nobody defined with "x" and 3
    Then the page contains "never checked"

  Scenario: An ambiguous step
    Given a duplicated step

  Scenario: A failing step skips the rest and the After hook still runs
    Given I am on "/login"
    Then the page contains "Not on this page"
    And the shop is open

  Scenario: A step definition that throws
    Given the step throws "business rule violated"
